import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { scanProject } from "../src/core/scan.ts";
import { SemanticFindingInputSchema, submitSemanticFindings, type SemanticFindingInput } from "../src/core/semantic.ts";
import { WorkspaceStore } from "../src/core/store.ts";
import { fixture, sourceByPath } from "./helpers.ts";

const FILES = {
  "AGENTS.md": "# Root\n- Use npm to run scripts.\n- Keep commits small.\n",
  "web/AGENTS.md": "# Web\n- Use pnpm to run scripts.\n",
};

const finding = (evidence: SemanticFindingInput["evidence"], checkId: SemanticFindingInput["checkId"] = "S03"): SemanticFindingInput => ({
  checkId,
  title: "Possible issue",
  message: "These lines might disagree.",
  severity: "warn",
  confidence: "medium",
  evidence,
});

test("evidence must cite current version, valid lines and the exact text", async () => {
  const fx = await fixture(FILES);
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const root = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const web = sourceByPath(fx.store, fx.projectId, "web/AGENTS.md");
    const ref = (s: typeof root, startLine: number, endLine: number, quote: string) => ({ sourceId: s.source.id, versionId: s.version.id, startLine, endLine, quote });

    const r = submitSemanticFindings(fx.store, {
      projectId: fx.projectId,
      reporter: "test",
      findings: [
        finding([ref(root, 2, 2, "- Use npm to run scripts.")]),
        finding([ref(root, 2, 3, "- Use npm to run scripts.\n- Keep commits small.")]),
        finding([ref(root, 2, 2, "- Use yarn to run scripts.")]),
        finding([ref(root, 9, 9, "x")]),
        finding([ref(root, 3, 2, "x")]),
        finding([{ sourceId: "src_0000000000000000", versionId: root.version.id, startLine: 1, endLine: 1, quote: "# Root" }]),
        finding([{ sourceId: "../../etc/passwd", versionId: "x", startLine: 1, endLine: 1, quote: "root" }]),
        finding([ref(root, 2, 2, "- Use npm to run scripts.")], "S01"),
        finding([ref(root, 2, 2, "- Use npm to run scripts."), ref(web, 2, 2, "- Use pnpm to run scripts.")], "S01"),
      ],
    });
    assert.equal(r.accepted.length, 3);
    assert.deepEqual(
      r.rejected.map((x) => [x.index, x.errors.map((e) => e.code)]),
      [[2, ["quote_mismatch"]], [3, ["line_range"]], [4, ["line_range"]], [5, ["unknown_source"]], [6, ["bad_id"]], [7, ["too_few_sources"]]],
    );
    const stored = fx.store.listFindings(fx.projectId, "semantic");
    assert.equal(stored.length, 3);
    assert.ok(stored.every((f) => f.kind === "semantic" && f.claim === "possible"));

    // The file changes on disk; old evidence is now stale.
    await writeFile(path.join(fx.root, "AGENTS.md"), "# Root\n- Use bun to run scripts.\n");
    await scanProject(fx.store, fx.projectId, "test");
    const stale = submitSemanticFindings(fx.store, { projectId: fx.projectId, reporter: "test", findings: [finding([ref(root, 2, 2, "- Use npm to run scripts.")])] });
    assert.deepEqual(stale.rejected[0]?.errors.map((e) => e.code), ["stale_version"]);
  } finally {
    await fx.cleanup();
  }
});

test("evidence from another project is rejected", async () => {
  const a = await fixture(FILES);
  try {
    await scanProject(a.store, a.projectId, "test");
    const other = a.store.addProject({ name: "other", rootReal: path.join(path.dirname(a.root), "workspace") });
    const root = sourceByPath(a.store, a.projectId, "AGENTS.md");
    const r = submitSemanticFindings(a.store, {
      projectId: other.id,
      reporter: "test",
      findings: [finding([{ sourceId: root.source.id, versionId: root.version.id, startLine: 1, endLine: 1, quote: "# Root" }])],
    });
    assert.deepEqual(r.rejected[0]?.errors.map((e) => e.code), ["wrong_project"]);
  } finally {
    await a.cleanup();
  }
});

test("assistant findings cannot claim error severity or unknown checks", () => {
  const base = finding([{ sourceId: "src_0000000000000000", versionId: "ver_0000000000000000", startLine: 1, endLine: 1, quote: "x" }]);
  assert.ok(SemanticFindingInputSchema.safeParse(base).success);
  assert.equal(SemanticFindingInputSchema.safeParse({ ...base, severity: "error" }).success, false);
  assert.equal(SemanticFindingInputSchema.safeParse({ ...base, checkId: "D01" }).success, false);
  assert.equal(SemanticFindingInputSchema.safeParse({ ...base, evidence: [] }).success, false);
});

test("store rejects non-workspace misuse: reopening keeps data", async () => {
  const fx = await fixture(FILES);
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const again = WorkspaceStore.open(fx.wsDir);
    try {
      assert.equal(again.listSources(fx.projectId).length, 2);
    } finally {
      again.close();
    }
  } finally {
    await fx.cleanup();
  }
});
