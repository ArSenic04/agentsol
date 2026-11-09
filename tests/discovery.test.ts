import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { scanProject } from "../src/core/scan.ts";
import { fixture, sourceByPath } from "./helpers.ts";

const FAKE_SECRET = "sk-FAKEFAKEFAKEFAKEFAKEFAKE1234567890";

test("discovery reads only supported instruction files and reports every exclusion", async () => {
  const fx = await fixture({
    "AGENTS.md": "# Root\n- Run the tests before committing.\n",
    "services/api/AGENTS.md": "# API\n- Keep handlers small.\n",
    "CLAUDE.md": "# Claude\n",
    "skills/pdf-tools/SKILL.md": "---\nname: pdf-tools\ndescription: Works with synthetic PDFs.\n---\nBody\n",
    "README.md": "not an instruction file",
    "node_modules/pkg/AGENTS.md": "ignored dependency",
    ".git/AGENTS.md": "ignored git internals",
    ".env": `OPENAI_API_KEY=${FAKE_SECRET}\n`,
    "config/credentials.json": "{}",
    ".ssh/AGENTS.md": "never read",
    "big/AGENTS.md": "x".repeat(300 * 1024),
    "bin/AGENTS.md": new Uint8Array([0x23, 0x00, 0x41]),
    "latin/AGENTS.md": new Uint8Array([0x23, 0x20, 0xe9, 0x0a]),
  });
  try {
    const outside = path.join(path.dirname(fx.root), "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "AGENTS.md"), "outside content must never be imported");
    await mkdir(path.join(fx.root, "link"));
    await symlink(path.join(outside, "AGENTS.md"), path.join(fx.root, "link", "AGENTS.md"));
    await symlink(outside, path.join(fx.root, "linkdir"));

    const r = await scanProject(fx.store, fx.projectId, "test");
    assert.ok(r.ok);
    const rels = fx.store.listSources(fx.projectId).map((s) => s.relPath).sort();
    assert.deepEqual(rels, ["AGENTS.md", "CLAUDE.md", "services/api/AGENTS.md", "skills/pdf-tools/SKILL.md"]);
    const excluded = Object.fromEntries(fx.store.listExclusions(fx.projectId).map((e) => [e.relPath, e.reason]));
    assert.deepEqual(excluded, {
      "big/AGENTS.md": "too_large",
      "bin/AGENTS.md": "binary",
      "latin/AGENTS.md": "invalid_utf8",
      "link/AGENTS.md": "symlink_not_followed",
    }, "only instruction-file names are recorded; .env, credentials.json, .ssh and linkdir are counted, not named");
    assert.ok(r.ok && r.value.skipped.secretLike === 3 && r.value.skipped.symlinks === 1, JSON.stringify(r.ok && r.value.skipped));
    for (const s of fx.store.listSources(fx.projectId)) {
      const v = s.currentVersionId ? fx.store.getVersion(s.currentVersionId) : null;
      assert.ok(v);
      assert.ok(!v.lines.join("\n").includes("outside content"));
    }
  } finally {
    await fx.cleanup();
  }
});

test("secret-like values are redacted before storage and flagged with a source-linked finding", async () => {
  const fx = await fixture({
    "AGENTS.md": `# Setup\nUse key ${FAKE_SECRET} for the demo.\npassword = hunter2hunter2hunter2\n-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKE\n-----END RSA PRIVATE KEY-----\nDone.\n`,
  });
  try {
    assert.ok((await scanProject(fx.store, fx.projectId, "test")).ok);
    const { version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const text = version.lines.join("\n");
    assert.ok(!text.includes(FAKE_SECRET));
    assert.ok(!text.includes("hunter2hunter2hunter2"));
    assert.ok(!text.includes("MIIFAKEFAKE"));
    assert.equal(version.lineCount, 7, "redaction preserves line numbers");
    assert.deepEqual(version.redactedLineNumbers, [2, 3, 4, 5, 6]);
    assert.equal(version.lines[6], "Done.");
    const d12 = fx.store.listFindings(fx.projectId).filter((f) => f.checkId === "D12");
    assert.equal(d12.length, 1);
    assert.equal(d12[0]?.evidence[0]?.startLine, 2);
  } finally {
    await fx.cleanup();
  }
});

test("rescan creates a new version only when bytes change and marks deleted files missing", async () => {
  const fx = await fixture({ "AGENTS.md": "one\n", "a/AGENTS.md": "two\n" });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const first = sourceByPath(fx.store, fx.projectId, "AGENTS.md").version.id;
    const again = await scanProject(fx.store, fx.projectId, "test");
    assert.ok(again.ok && again.value.newVersions === 0);
    assert.equal(sourceByPath(fx.store, fx.projectId, "AGENTS.md").version.id, first);
    await writeFile(path.join(fx.root, "AGENTS.md"), "one changed\n");
    const { rm } = await import("node:fs/promises");
    await rm(path.join(fx.root, "a", "AGENTS.md"));
    const third = await scanProject(fx.store, fx.projectId, "test");
    assert.ok(third.ok && third.value.newVersions === 1 && third.value.missing === 1);
    assert.notEqual(sourceByPath(fx.store, fx.projectId, "AGENTS.md").version.id, first);
    assert.equal(fx.store.listSources(fx.projectId).find((s) => s.relPath === "a/AGENTS.md")?.status, "missing");
  } finally {
    await fx.cleanup();
  }
});
