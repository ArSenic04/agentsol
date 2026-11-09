import assert from "node:assert/strict";
import { link, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareMeta, FRESHNESS_CAVEATS } from "../src/core/freshness.ts";
import { applyApprovedProposal, approveProposal } from "../src/core/humanApproval.ts";
import { proposeChange } from "../src/core/proposals.ts";
import { createAssistantService } from "../src/core/service/assistant.ts";
import { DB_FILE } from "../src/core/store.ts";
import { fixture, sourceByPath, tempDir, writeTree, type Fixture } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svcFor = (fx: Fixture) => createAssistantService(fx.store, { reporter: () => "assistant:test", onInternalError: () => {} });

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) assert.fail(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
const stateOf = (r: { sources: { relPath: string; state: string }[] }, rel: string) => r.sources.find((s) => s.relPath === rel)?.state;

test("a file edited after the scan is reported as changed; findings stay a labelled snapshot until rescan", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n- Use npm.\n", "web/AGENTS.md": "# Web\n" });
  try {
    const svc = svcFor(fx);
    value(await svc.scan({ projectId: fx.projectId }));
    const fresh = value(await svc.freshness({ projectId: fx.projectId }));
    assert.equal(fresh.freshness.state, "no_known_changes");
    assert.deepEqual(fresh.caveats, FRESHNESS_CAVEATS);
    assert.ok(fresh.caveats.some((c) => /does not prove/.test(c)));
    assert.ok(fresh.caveats.some((c) => /New instruction files are not detected/.test(c)));

    await writeFile(path.join(fx.root, "AGENTS.md"), "# Root\n- Use pnpm, always.\n");
    const after = value(await svc.freshness({ projectId: fx.projectId }));
    assert.equal(after.freshness.state, "changes_detected");
    assert.equal(stateOf(after, "AGENTS.md"), "changed");
    assert.equal(stateOf(after, "web/AGENTS.md"), "metadata_unchanged");
    const status = value(await svc.projectStatus({ projectId: fx.projectId }));
    assert.equal(status.freshness.state, "changes_detected");
    assert.equal(status.findings.basis, "last_scan_snapshot");
    assert.equal(status.scan.state, "scanned");
    if (status.scan.state === "scanned") assert.equal(status.scan.partial, false, "partial coverage is separate from freshness");

    value(await svc.scan({ projectId: fx.projectId }));
    assert.equal(value(await svc.freshness({ projectId: fx.projectId })).freshness.state, "no_known_changes");
  } finally {
    await fx.cleanup();
  }
});

test("same size and restored mtime: metadata is only a hint; apply still refuses by byte hash", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n- Use npm to run scripts.\n" });
  try {
    const svc = svcFor(fx);
    value(await svc.scan({ projectId: fx.projectId }));
    const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const proposed = proposeChange(fx.store, {
      projectId: fx.projectId, author: "assistant:test",
      input: { sourceId: source.id, baseVersionId: version.id, findingIds: [], rationale: "synthetic", edits: [{ startLine: 2, endLine: 2, expectedText: "- Use npm to run scripts.", replacementLines: ["- Use pnpm to run scripts."] }] },
    });
    assert.ok(proposed.ok);
    const file = path.join(fx.root, "AGENTS.md");
    const before = await stat(file);
    await writeFile(file, "# Root\n- Use bun to run scripts.\n");
    assert.equal((await stat(file)).size, before.size, "same size on purpose");
    await utimes(file, before.atime, before.mtime);
    // ctime cannot be restored from user space, so this platform still sees a change ...
    const seen = value(await svc.freshness({ projectId: fx.projectId }));
    assert.equal(stateOf(seen, "AGENTS.md"), "changed");
    // ... but equal metadata (for example on a restored backup or a coarse filesystem) is NOT proof.
    const recorded = fx.store.getObservation(source.id);
    assert.ok(recorded);
    assert.equal(compareMeta(recorded.meta, recorded.meta), "metadata_unchanged");
    // The apply guard ignores metadata and compares bytes.
    const p = fx.store.getProposal(proposed.value.proposal.id);
    assert.ok(p);
    assert.ok(approveProposal(fx.store, { proposalId: p.body.id, reviewedProposalSha256: p.body.proposalSha256, decidedBy: "local-user:test" }).ok);
    const applied = await applyApprovedProposal(fx.store, { proposalId: p.body.id, actor: "local-user:test" });
    assert.ok(!applied.ok && applied.error.code === "stale_on_disk");
    assert.equal(await readFile(file, "utf8"), "# Root\n- Use bun to run scripts.\n");
  } finally {
    await fx.cleanup();
  }
});

test("removed, symlinked and hard-linked files are reported, and new files are not claimed", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n", "a/AGENTS.md": "# A\n", "b/AGENTS.md": "# B\n", "c/AGENTS.md": "# C\n" });
  try {
    const svc = svcFor(fx);
    value(await svc.scan({ projectId: fx.projectId }));
    await rm(path.join(fx.root, "a/AGENTS.md"));
    await rm(path.join(fx.root, "b/AGENTS.md"));
    await symlink("../AGENTS.md", path.join(fx.root, "b/AGENTS.md"));
    await link(path.join(fx.root, "c/AGENTS.md"), path.join(fx.root, "c-copy.txt"));
    await writeTree(fx.root, { "new/AGENTS.md": "# New\n" });
    const r = value(await svc.freshness({ projectId: fx.projectId }));
    assert.equal(stateOf(r, "a/AGENTS.md"), "removed");
    assert.equal(stateOf(r, "b/AGENTS.md"), "unsafe");
    assert.equal(stateOf(r, "c/AGENTS.md"), "unsafe", "a new hard link makes the file unsafe to trust");
    assert.equal(stateOf(r, "new/AGENTS.md"), undefined, "new files are not detected without a scan");
    assert.equal(r.freshness.state, "changes_detected");
    if (r.freshness.state === "changes_detected") assert.deepEqual(r.freshness.counts, { metadata_unchanged: 1, changed: 0, removed: 1, unsafe: 2, unknown: 0 });
  } finally {
    await fx.cleanup();
  }
});

test("missing, replaced or symlinked project roots are unknown, never clean, and leak no paths", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n" });
  const moved = `${fx.root}-moved`;
  try {
    const svc = svcFor(fx);
    assert.deepEqual(value(await svc.freshness({ projectId: fx.projectId })).freshness, { state: "not_checked", reason: "never_scanned" });
    value(await svc.scan({ projectId: fx.projectId }));

    await rename(fx.root, moved);
    let r = value(await svc.freshness({ projectId: fx.projectId }));
    assert.equal(r.freshness.state, "unknown");
    if (r.freshness.state === "unknown") assert.equal(r.freshness.reason, "root_unavailable");
    assert.deepEqual(r.sources, []);

    await symlink(moved, fx.root);
    r = value(await svc.freshness({ projectId: fx.projectId }));
    assert.ok(r.freshness.state === "unknown" && r.freshness.reason === "root_unavailable", "a symlinked root is not followed");
    await rm(fx.root);

    await mkdir(fx.root);
    await writeFile(path.join(fx.root, "AGENTS.md"), await readFile(path.join(moved, "AGENTS.md")));
    r = value(await svc.freshness({ projectId: fx.projectId }));
    assert.ok(r.freshness.state === "unknown" && r.freshness.reason === "root_replaced", JSON.stringify(r.freshness));
    const status = value(await svc.status());
    const text = JSON.stringify([r, status]);
    assert.ok(!text.includes(fx.root) && !text.includes(path.dirname(fx.root)), "no absolute paths in freshness or status");
  } finally {
    await rm(moved, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("data from an older scan without metadata is incomplete or unknown, not clean", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n", "a/AGENTS.md": "# A\n" });
  try {
    const svc = svcFor(fx);
    value(await svc.scan({ projectId: fx.projectId }));
    fx.store.deleteObservation(sourceByPath(fx.store, fx.projectId, "a/AGENTS.md").source.id);
    const r = value(await svc.freshness({ projectId: fx.projectId }));
    assert.equal(r.freshness.state, "incomplete");
    assert.equal(stateOf(r, "a/AGENTS.md"), "unknown");
    const db = new DatabaseSync(path.join(fx.wsDir, DB_FILE));
    db.exec("DELETE FROM root_observations");
    db.close();
    const r2 = value(await svc.freshness({ projectId: fx.projectId }));
    assert.ok(r2.freshness.state === "unknown" && r2.freshness.reason === "no_root_metadata");
  } finally {
    await fx.cleanup();
  }
});

test("a change in one project does not affect another project's freshness", async () => {
  const a = await fixture({ "AGENTS.md": "# A\n" });
  const bRoot = path.join(await tempDir("fresh-b"), "b");
  try {
    await mkdir(bRoot);
    await writeTree(bRoot, { "AGENTS.md": "# B\n" });
    const b = a.store.addProject({ name: "b", rootReal: bRoot });
    const svc = svcFor(a);
    value(await svc.scan({ projectId: a.projectId }));
    value(await svc.scan({ projectId: b.id }));
    await writeFile(path.join(a.root, "AGENTS.md"), "# A changed\n");
    assert.equal(value(await svc.freshness({ projectId: a.projectId })).freshness.state, "changes_detected");
    assert.equal(value(await svc.freshness({ projectId: b.id })).freshness.state, "no_known_changes");
    const bSources = value(await svc.freshness({ projectId: b.id })).sources;
    assert.ok(bSources.every((s) => s.sourceId.startsWith("src_") && !a.store.listSources(a.projectId).some((x) => x.id === s.sourceId)));
  } finally {
    await a.cleanup();
    await rm(path.dirname(bRoot), { recursive: true, force: true });
  }
});

test("freshness is never part of the approval or evidence guards", async () => {
  const guarded = ["humanApproval.ts", "proposals.ts", "evidence.ts", "semantic.ts"];
  for (const f of guarded) {
    const text = await readFile(path.join(REPO, "src/core", f), "utf8");
    assert.ok(!/freshness|fileMeta|getObservation/.test(text), `${f} must not use metadata freshness`);
  }
});
