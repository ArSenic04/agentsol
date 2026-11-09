/**
 * Bounded synthetic monorepo (about 1,000 files) covering scope layering, duplicates,
 * malformed and unreadable files, links, limits, retries, concurrency and staleness.
 * Larger measured runs live in scripts/loadTest.ts (not part of npm test).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { diffSnapshots, FAKE_SECRET, generateBigProject, SHARED_LINE, snapshotTree } from "../scripts/bigFixture.ts";
import { applyApprovedProposal, approveProposal } from "../src/core/humanApproval.ts";
import type { ProposalId } from "../src/core/ids.ts";
import { createAssistantService } from "../src/core/service/assistant.ts";
import { createOperatorService } from "../src/core/service/operator.ts";
import { WorkspaceStore } from "../src/core/store.ts";
import { tempDir } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function setup(opts: Parameters<typeof generateBigProject>[1]) {
  const base = await tempDir("big");
  const root = path.join(base, "monorepo");
  await mkdir(root);
  const stats = await generateBigProject(root, opts);
  const wsDir = path.join(base, "workspace");
  const store = WorkspaceStore.open(wsDir);
  const ops = createOperatorService(store, { actor: () => "local-user:test", homeReal: await realpath(homedir()) });
  const reg = await ops.registerProject(root, "synthetic-monorepo");
  assert.ok(reg.ok);
  const svc = createAssistantService(store, { reporter: () => "assistant:test", onInternalError: (op, e) => { throw new Error(`${op}: ${String(e)}`); } });
  return { base, root, wsDir, store, svc, stats, projectId: reg.value.project.id, cleanup: async () => { store.close(); await rm(base, { recursive: true, force: true }); } };
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

test("synthetic monorepo: layered scopes, every edge case reported, nothing silently skipped, bytes unchanged", async () => {
  const fx = await setup({ packages: 20, otherFilesPerPackage: 40, skillsPerPackage: 2 });
  try {
    assert.ok(fx.stats.totalFiles >= 900, `fixture has ${fx.stats.totalFiles} files`);
    const before = await snapshotTree(fx.root);
    const scan = value(await fx.svc.scan({ projectId: fx.projectId }));
    const listed = value(fx.svc.listSources({ projectId: fx.projectId }));
    const paths = listed.sources.map((s) => s.relPath);
    for (const bad of paths) assert.ok(!/^(node_modules|\.git|secrets)\//.test(bad), `never read ${bad}`);
    const reasons = new Map(listed.notRead.map((n) => [n.relPath, n.reason]));
    assert.deepEqual(Object.fromEntries([...reasons].filter(([p]) => p.startsWith("edge/")).sort()), {
      "edge/binary/AGENTS.md": "binary",
      "edge/case/agents.md": "case_variant_name",
      "edge/fifo/AGENTS.md": "not_regular_file",
      "edge/hardlink/AGENTS.md": "hard_link",
      "edge/invalid-utf8/AGENTS.md": "invalid_utf8",
      "edge/large/AGENTS.md": "too_large",
      "edge/local/CLAUDE.local.md": "personal_local_file",
      "edge/symlink/AGENTS.md": "symlink_not_followed",
    });
    assert.equal(scan.skipped.depthLimited, 1);
    assert.ok(scan.skipped.skippedDirs >= 2, "node_modules and .git counted");
    assert.equal(scan.skipped.secretLike, 1);
    // Every instruction-named entry we created is read or reported, except the one below the depth limit (counted in skipped.depthLimited).
    assert.equal(scan.sources + [...reasons].length + 1, fx.stats.instructionFiles, "every instruction file is either read or reported");

    const status = value(await fx.svc.projectStatus({ projectId: fx.projectId }));
    assert.equal(status.scan.state, "scanned");
    assert.ok(status.scan.state === "scanned" && status.scan.partial, "coverage is reported as partial, not clean");

    const { findings } = value(fx.svc.listFindings({ projectId: fx.projectId }));
    const byCheck = (id: string) => findings.filter((f) => f.checkId === id);
    const dup = byCheck("D10").find((f) => f.message.includes("identical") || f.evidence.length > 2);
    assert.ok(dup, "shared line is reported as a duplicate");
    assert.equal(dup.severity, "info", "duplicates are info, not conflicts");
    assert.ok(byCheck("D01").length >= 3, "malformed frontmatter reported (2 broken YAML + 1 missing)");
    assert.ok(byCheck("D09").some((f) => f.message.includes("docs/missing.md")));
    assert.ok(byCheck("D00").some((f) => f.evidence[0]?.relPath === "edge/empty/AGENTS.md"));
    assert.ok(byCheck("D12").some((f) => f.evidence[0]?.relPath === "edge/secret/AGENTS.md"));
    assert.ok(byCheck("D08").length >= 1, "CLAUDE.md vs AGENTS.md precedence reported");
    assert.ok(!JSON.stringify(findings).includes(FAKE_SECRET), "secret never echoed");
    const secretSrc = listed.sources.find((src) => src.relPath === "edge/secret/AGENTS.md");
    assert.ok(secretSrc, "the secret-bearing instruction file is a source");
    const secretRead = JSON.stringify(value(fx.svc.readSource({ projectId: fx.projectId, sourceId: secretSrc.sourceId })));
    assert.ok(!secretRead.includes(FAKE_SECRET), "source_read redacts the synthetic secret");
    assert.ok(!listed.sources.some((src) => src.relPath.startsWith("secrets/") || src.relPath.includes("node_modules/") || src.relPath.startsWith(".git/")), "ignored folders are never sources");
    assert.ok(!findings.some((f) => f.kind === "semantic"), "no 'possible' findings appear without an assistant");

    // Scope layering for a deep file in a package with an override and a nested scope.
    const scope = value(fx.svc.resolveScope({ projectId: fx.projectId, targetPath: "packages/p0/src/feature/x.ts", platform: "codex", workingDirectory: "packages/p0/src/feature" }));
    const chain = JSON.stringify(scope);
    assert.ok(chain.includes("packages/p0/AGENTS.override.md") && chain.includes("packages/p0/src/feature/AGENTS.md"), chain.slice(0, 400));

    const rescan = value(await fx.svc.scan({ projectId: fx.projectId }));
    assert.equal(rescan.newVersions, 0, "an unchanged tree records no new versions");
    assert.deepEqual(diffSnapshots(before, await snapshotTree(fx.root)), [], "scan never changes a byte");
    assert.ok(SHARED_LINE.length > 0);
  } finally {
    await fx.cleanup();
  }
});

test("source limit: truncation is reported per file and as partial coverage", async () => {
  const fx = await setup({ packages: 5, otherFilesPerPackage: 2, skillsPerPackage: 1, overflow: 520, edges: false });
  try {
    const scan = value(await fx.svc.scan({ projectId: fx.projectId }));
    assert.equal(scan.sources, 500);
    const listed = value(fx.svc.listSources({ projectId: fx.projectId }));
    const limited = listed.notRead.filter((n) => n.reason === "limit_reached").length;
    assert.equal(scan.sources + limited, fx.stats.instructionFiles);
    const status = value(await fx.svc.projectStatus({ projectId: fx.projectId }));
    assert.ok(status.scan.state === "scanned" && status.scan.partialReasons.some((r) => r.includes("limit_reached")), JSON.stringify(status.scan));
  } finally {
    await fx.cleanup();
  }
});

test("retries, concurrent writers in separate processes, and stale proposals", async () => {
  const fx = await setup({ packages: 4, otherFilesPerPackage: 2, skillsPerPackage: 1, edges: false });
  try {
    value(await fx.svc.scan({ projectId: fx.projectId }));
    const src = value(fx.svc.listSources({ projectId: fx.projectId })).sources.find((s) => s.relPath === "packages/p1/AGENTS.md");
    assert.ok(src);
    const read = value(fx.svc.readSource({ projectId: fx.projectId, sourceId: src.sourceId }));
    const change = (replacement: string, requestKey?: string) => ({
      projectId: fx.projectId, requestKey, sourceId: src.sourceId, baseVersionId: read.versionId, findingIds: [], rationale: "synthetic",
      edits: [{ startLine: 3, endLine: 3, expectedText: "- Use npm to run scripts in this package.", replacementLines: [replacement] }],
    });
    const a = value(fx.svc.proposeChange(change("- Use pnpm here.", "retry-key-0001")));
    const b = value(fx.svc.proposeChange(change("- Use pnpm here.", "retry-key-0001")));
    assert.equal(a.proposalId, b.proposalId, "same key + same request = same proposal");
    const conflict = fx.svc.proposeChange(change("- Use yarn here.", "retry-key-0001"));
    assert.ok(!conflict.ok && conflict.error.code === "request_key_conflict");

    // 6 processes race: 3 reuse one key, 3 use their own keys. Expect exactly 1 + 3 new proposals.
    const child = (key: string, text: string) => new Promise<number>((resolve) => {
      const code = `
        import { WorkspaceStore } from ${JSON.stringify(path.join(REPO, "src/core/store.ts"))};
        import { createAssistantService } from ${JSON.stringify(path.join(REPO, "src/core/service/assistant.ts"))};
        const store = WorkspaceStore.open(${JSON.stringify(fx.wsDir)});
        const svc = createAssistantService(store, { reporter: () => "assistant:child", onInternalError: (op, e) => { console.error(op, e); process.exit(3); } });
        const r = svc.proposeChange(${JSON.stringify(change(text, key))});
        store.close();
        process.exit(r.ok ? 0 : 1);`;
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
      p.on("exit", (c) => resolve(c ?? 9));
    });
    const codes = await Promise.all([
      child("race-shared-key", "- Use bun here."), child("race-shared-key", "- Use bun here."), child("race-shared-key", "- Use bun here."),
      child("race-key-a", "- Use deno here."), child("race-key-b", "- Use make here."), child("race-key-c", "- Use just here."),
    ]);
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], "no process failed on a locked database");
    const proposals = value(fx.svc.listProposals({ projectId: fx.projectId })).proposals;
    assert.equal(proposals.length, 1 + 1 + 3, "one per distinct request, retries deduplicated across processes");

    // Stale, case 1: approved, then a person edits the file before apply. Apply must not write.
    const approvedFirst = fx.store.getProposal(a.proposalId as ProposalId);
    assert.ok(approvedFirst);
    const approval = approveProposal(fx.store, { proposalId: approvedFirst.body.id, reviewedProposalSha256: approvedFirst.body.proposalSha256, decidedBy: "local-user:test" });
    assert.ok(approval.ok, JSON.stringify(!approval.ok && approval.error));
    const file = path.join(fx.root, "packages/p1/AGENTS.md");
    const edited = "# Package p1\n- edited by a person\n";
    await writeFile(file, edited);
    const applied = await applyApprovedProposal(fx.store, { proposalId: approvedFirst.body.id, actor: "local-user:test" });
    assert.ok(!applied.ok && applied.error.code === "stale_on_disk", JSON.stringify(!applied.ok && applied.error));
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(file, "utf8"), edited, "the person's edit is kept");

    // Stale, case 2: after a rescan, the other proposals show baseIsCurrent=false and cannot be approved.
    value(await fx.svc.scan({ projectId: fx.projectId }));
    const after = value(fx.svc.listProposals({ projectId: fx.projectId })).proposals;
    const other = after.find((p) => p.proposalId !== a.proposalId);
    assert.ok(other && other.baseIsCurrent === false);
    const otherStored = fx.store.getProposal(other.proposalId as ProposalId);
    assert.ok(otherStored);
    const refused = approveProposal(fx.store, { proposalId: otherStored.body.id, reviewedProposalSha256: otherStored.body.proposalSha256, decidedBy: "local-user:test" });
    assert.ok(!refused.ok && refused.error.code === "stale_version", JSON.stringify(!refused.ok && refused.error));
  } finally {
    await fx.cleanup();
  }
});
