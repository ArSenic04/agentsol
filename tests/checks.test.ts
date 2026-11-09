import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSourcesFor, scanProject } from "../src/core/scan.ts";
import { resolveScope, type ScopeSource } from "../src/core/scope.ts";
import type { Finding } from "../src/core/schemas.ts";
import { fixture } from "./helpers.ts";

async function findingsFor(files: Record<string, string>): Promise<Finding[]> {
  const fx = await fixture(files);
  try {
    const r = await scanProject(fx.store, fx.projectId, "test");
    assert.ok(r.ok);
    return fx.store.listFindings(fx.projectId);
  } finally {
    await fx.cleanup();
  }
}
const ids = (fs: Finding[]): string[] => fs.map((f) => `${f.checkId}:${f.evidence[0]?.relPath}`).sort();

test("valid skill produces no findings", async () => {
  const fs = await findingsFor({ "skills/pdf-tools/SKILL.md": "---\nname: pdf-tools\ndescription: Fill synthetic PDF forms.\n---\n# Steps\n" });
  assert.deepEqual(fs, []);
});

test("malformed skill frontmatter is reported, never crashes", async () => {
  const fs = await findingsFor({
    "skills/a/SKILL.md": "# no frontmatter\n",
    "skills/b/SKILL.md": "---\nname: b\ndescription: never closed\n",
    "skills/c/SKILL.md": "---\nname: [unclosed\n---\n",
    "skills/d/SKILL.md": "---\n- just\n- a list\n---\n",
    "skills/e/SKILL.md": "---\nname: e\nname: e\ndescription: dup\n---\n",
    "skills/f/SKILL.md": "---\na: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c]\n---\n",
  });
  for (const k of ["a", "b", "c", "d", "e", "f"]) {
    assert.ok(fs.some((f) => f.checkId === "D01" && f.evidence[0]?.relPath === `skills/${k}/SKILL.md`), `skills/${k} should get D01`);
  }
});

test("skill naming and description rules", async () => {
  const fs = await findingsFor({
    "skills/pdf-tools/SKILL.md": "---\nname: PDF-Tools\ndescription: ok\n---\n",
    "skills/other/SKILL.md": "---\nname: mismatch\ndescription: ok\n---\n",
    "skills/nodesc/SKILL.md": "---\nname: nodesc\n---\n",
    "skills/long/SKILL.md": `---\nname: long\ndescription: ${"d".repeat(1100)}\ncompatibility: ${"c".repeat(600)}\n---\n`,
  });
  assert.deepEqual(ids(fs), [
    "D02:skills/other/SKILL.md",
    "D02:skills/pdf-tools/SKILL.md",
    "D03:skills/long/SKILL.md",
    "D03:skills/nodesc/SKILL.md",
    "D04:skills/long/SKILL.md",
  ]);
});

test("empty files, size guidelines, imports and precedence", async () => {
  const fs = await findingsFor({
    "empty/AGENTS.md": "  \n\n",
    "CLAUDE.md": "See @docs/style.md and @docs/missing.md and @../../etc/passwd and @/etc/hosts\n```\n@docs/in-fence.md\n```\nUse `@docs/inline.md` literally.\n",
    "docs/style.md": "style",
    "AGENTS.md": "# Root agents\n",
    "pkg/AGENTS.md": "# Pkg\n",
    "pkg/AGENTS.override.md": "# Override\n",
    "big/CLAUDE.md": "line\n".repeat(250),
  });
  const d09 = fs.filter((f) => f.checkId === "D09").map((f) => f.message);
  assert.equal(d09.length, 3, d09.join("\n"));
  assert.ok(d09.some((m) => m.includes("docs/missing.md")));
  assert.ok(d09.some((m) => m.includes("outside the project root")));
  assert.ok(d09.some((m) => m.includes("absolute path")));
  assert.ok(!d09.some((m) => m.includes("in-fence") || m.includes("inline")));
  assert.ok(fs.some((f) => f.checkId === "D00" && f.evidence[0]?.relPath === "empty/AGENTS.md"));
  assert.ok(fs.some((f) => f.checkId === "D07" && f.evidence[0]?.relPath === "big/CLAUDE.md"));
  const d08 = fs.filter((f) => f.checkId === "D08").map((f) => f.evidence[0]?.relPath).sort();
  // Empty files only get D00; precedence is reported for files with content.
  assert.deepEqual(d08, ["AGENTS.md", "pkg/AGENTS.md", "pkg/AGENTS.md"]);
});

test("overlapping scopes are layered, not conflicts; identical lines are labelled not-a-conflict", async () => {
  const layered = await findingsFor({
    "AGENTS.md": "# Root\n- Use npm for scripts in this repository.\n",
    "services/api/AGENTS.md": "# API\n- Use pnpm for scripts in this package.\n",
  });
  assert.deepEqual(layered, [], "different nested guidance is not flagged by deterministic checks");

  const dup = await findingsFor({
    "AGENTS.md": "- Always run the unit tests before you commit.\n",
    "web/AGENTS.md": "-   Always run the unit tests before you commit.\n",
  });
  assert.equal(dup.length, 1);
  assert.equal(dup[0]?.checkId, "D10");
  assert.match(dup[0]?.message ?? "", /not a conflict/);
  assert.equal(dup[0]?.evidence.length, 2);
});

test("scope resolution follows each client's documented layering", async () => {
  const fx = await fixture({
    "AGENTS.md": "root\n",
    "services/AGENTS.md": "services\n",
    "services/api/AGENTS.md": "api\n",
    "services/api/AGENTS.override.md": "override\n",
    "web/CLAUDE.md": "web claude\n",
    "web/AGENTS.md": "web agents\n",
  });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const sources: ScopeSource[] = checkSourcesFor(fx.store, fx.projectId).map((s) => ({ sourceId: s.sourceId, relPath: s.relPath, format: s.format, empty: s.lines.every((l) => l.trim() === "") }));
    const chain = (targetPath: string, platform: "codex" | "claude-code" | "cursor", workingDirectory?: string) => {
      const r = resolveScope({ sources, targetPath, platform, workingDirectory });
      assert.ok(r.ok);
      assert.equal(r.value.relationship, "layered");
      assert.equal(r.value.coverage, "partial");
      assert.ok(r.value.notInspected.length > 0);
      return r.value.chain.map((c) => `${c.when}:${c.relPath}`);
    };
    // Codex loads root -> working directory only; nothing below the working directory.
    assert.deepEqual(chain("services/api/handler.ts", "codex"), ["launch:AGENTS.md"]);
    assert.deepEqual(chain("services/api/handler.ts", "codex", "services/api"), ["launch:AGENTS.md", "launch:services/AGENTS.md", "launch:services/api/AGENTS.override.md"]);
    // Claude Code: no CLAUDE.md at/above the root, so AGENTS.md at launch; web/CLAUDE.md on demand.
    assert.deepEqual(chain("web/app.tsx", "claude-code"), ["launch:AGENTS.md", "on_demand:web/CLAUDE.md"]);
    assert.deepEqual(chain("web/app.tsx", "claude-code", "web"), ["launch:web/CLAUDE.md"]);
    assert.deepEqual(chain("services/api/handler.ts", "claude-code"), ["launch:AGENTS.md", "on_demand:services/AGENTS.md", "on_demand:services/api/AGENTS.md"]);
    assert.deepEqual(chain("services/api/handler.ts", "cursor"), ["launch:AGENTS.md", "launch:services/AGENTS.md", "launch:services/api/AGENTS.md"]);
    const bad = resolveScope({ sources, targetPath: "../outside.ts", platform: "codex" });
    assert.equal(bad.ok, false);
  } finally {
    await fx.cleanup();
  }
});
