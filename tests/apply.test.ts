import assert from "node:assert/strict";
import { chmod, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { applyApprovedProposal, approveProposal, confirmationCode, rejectProposal } from "../src/core/humanApproval.ts";
import type { ProposalId } from "../src/core/ids.ts";
import { proposeChange, type ProposeInput } from "../src/core/proposals.ts";
import { scanProject } from "../src/core/scan.ts";
import type { LineEdit } from "../src/core/schemas.ts";
import { fixture, sourceByPath, type Fixture } from "./helpers.ts";

const ORIGINAL = "# Root\n- Use npm to run scripts.\n- Keep commits small.\n";

async function setup(content = ORIGINAL): Promise<Fixture> {
  const fx = await fixture({ "AGENTS.md": content });
  assert.ok((await scanProject(fx.store, fx.projectId, "test")).ok);
  return fx;
}

function propose(fx: Fixture, edits: LineEdit[], extra: Partial<ProposeInput> = {}) {
  const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
  return proposeChange(fx.store, {
    projectId: fx.projectId,
    author: "assistant:test",
    input: { sourceId: source.id, baseVersionId: version.id, findingIds: [], rationale: "synthetic test", edits, ...extra },
  });
}

function mustPropose(fx: Fixture, edits: LineEdit[]): ProposalId {
  const r = propose(fx, edits);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
  return r.value.proposal.id;
}

function approve(fx: Fixture, id: ProposalId): void {
  const p = fx.store.getProposal(id);
  assert.ok(p);
  const r = approveProposal(fx.store, { proposalId: id, confirmCode: confirmationCode(p.body), decidedBy: "local-user:test" });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
}

const EDIT: LineEdit = { startLine: 2, endLine: 2, expectedText: "- Use npm to run scripts.", replacementLines: ["- Use pnpm to run scripts."] };
const readRoot = (fx: Fixture) => readFile(path.join(fx.root, "AGENTS.md"), "utf8");

test("proposals are validated and never write files", async () => {
  const fx = await setup(`${ORIGINAL}token sk-FAKEFAKEFAKEFAKEFAKEFAKE1234567890\n`);
  try {
    const before = await readRoot(fx);
    const codes = (edits: LineEdit[], extra?: Partial<ProposeInput>) => {
      const r = propose(fx, edits, extra);
      return r.ok ? ["ok"] : r.error.map((e) => e.code);
    };
    assert.deepEqual(codes([{ ...EDIT, expectedText: "- Use yarn to run scripts." }]), ["expected_mismatch"]);
    assert.deepEqual(codes([EDIT, { ...EDIT, replacementLines: ["x"] }]), ["overlap"]);
    assert.ok(codes([{ startLine: 4, endLine: 4, expectedText: "", replacementLines: ["x"] }]).includes("redacted_line"));
    assert.deepEqual(codes([{ ...EDIT, replacementLines: ["api_key = AKIAFAKEFAKEFAKEFAKE"] }]), ["secret_in_replacement"]);
    assert.deepEqual(codes([{ ...EDIT, replacementLines: ["two\nlines"] }]), ["invalid_line"]);
    assert.deepEqual(codes([{ ...EDIT, replacementLines: ["- Use npm to run scripts."] }]), ["no_change"]);
    assert.deepEqual(codes([{ ...EDIT, startLine: 40, endLine: 40 }]), ["line_range"]);
    assert.deepEqual(codes([EDIT], { findingIds: ["fnd_0000000000000000"] }), ["unknown_finding"]);
    assert.deepEqual(codes([EDIT], { baseVersionId: "ver_0000000000000000" }), ["stale_version"]);
    assert.deepEqual(codes([EDIT]), ["ok"]);
    assert.equal(await readRoot(fx), before, "file untouched by proposing");
  } finally {
    await fx.cleanup();
  }
});

test("approval requires the exact confirmation code and a pending, current proposal", async () => {
  const fx = await setup();
  try {
    const id = mustPropose(fx, [EDIT]);
    const wrong = approveProposal(fx.store, { proposalId: id, confirmCode: "000000000000", decidedBy: "u" });
    assert.ok(!wrong.ok && wrong.error.code === "confirm_mismatch");
    const noApproval = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    assert.ok(!noApproval.ok && noApproval.error.code === "no_approval");
    assert.equal(await readRoot(fx), ORIGINAL);
    approve(fx, id);
    const twice = approveProposal(fx.store, { proposalId: id, confirmCode: confirmationCode(fx.store.getProposal(id)!.body), decidedBy: "u" });
    assert.ok(!twice.ok && twice.error.code === "already_approved");
  } finally {
    await fx.cleanup();
  }
});

test("approved apply writes the change, keeps a backup, records a version and is single-use", async () => {
  const fx = await setup();
  try {
    const id = mustPropose(fx, [EDIT, { startLine: 3, endLine: 3, expectedText: "- Keep commits small.", replacementLines: ["- Keep commits small.", "- Write tests."] }]);
    approve(fx, id);
    const r = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.equal(await readRoot(fx), "# Root\n- Use pnpm to run scripts.\n- Keep commits small.\n- Write tests.\n");
    assert.equal(await readFile(r.value.backupPath, "utf8"), ORIGINAL);
    assert.ok(r.value.backupPath.startsWith(path.join(fx.wsDir, "backups")), "backup lives in the workspace, not the project");
    assert.deepEqual((await readdir(fx.root)).sort(), ["AGENTS.md"], "no temp or backup files left in the project");
    assert.equal(fx.store.getProposal(id)?.status, "applied");
    assert.equal(sourceByPath(fx.store, fx.projectId, "AGENTS.md").version.id, r.value.newVersionId);
    assert.deepEqual(fx.store.listApprovals(id).map((a) => a.state), ["consumed"]);
    const again = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    assert.ok(!again.ok && again.error.code === "not_pending");
  } finally {
    await fx.cleanup();
  }
});

test("an approval only applies to the exact proposal it was given for", async () => {
  const fx = await setup();
  try {
    const a = mustPropose(fx, [EDIT]);
    const b = mustPropose(fx, [{ ...EDIT, replacementLines: ["- Use bun to run scripts."] }]);
    approve(fx, a);
    const wrong = await applyApprovedProposal(fx.store, { proposalId: b, actor: "u" });
    assert.ok(!wrong.ok && wrong.error.code === "no_approval");
    // A forged approval row with a different digest is voided, not used.
    const pb = fx.store.getProposal(b)!.body;
    fx.store.insertApproval({ proposalId: b, proposalSha256: "0".repeat(64), baseRawSha256: pb.baseRawSha256, decidedBy: "forged" });
    const forged = await applyApprovedProposal(fx.store, { proposalId: b, actor: "u" });
    assert.ok(!forged.ok && forged.error.code === "approval_mismatch");
    assert.deepEqual(fx.store.listApprovals(b).map((x) => x.state), ["void"]);
    assert.equal(await readRoot(fx), ORIGINAL);
  } finally {
    await fx.cleanup();
  }
});

test("a file edited on disk after approval makes the proposal stale and is not overwritten", async () => {
  const fx = await setup();
  try {
    const id = mustPropose(fx, [EDIT]);
    approve(fx, id);
    const human = "# Root\n- Human edited this line.\n- Keep commits small.\n";
    await writeFile(path.join(fx.root, "AGENTS.md"), human);
    const r = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    assert.ok(!r.ok && r.error.code === "stale_on_disk");
    assert.equal(await readRoot(fx), human);
    assert.equal(fx.store.getProposal(id)?.status, "stale");
    assert.deepEqual(fx.store.listApprovals(id).map((a) => a.state), ["consumed"]);
  } finally {
    await fx.cleanup();
  }
});

test("a proposal goes stale for approval once a rescan sees a newer version", async () => {
  const fx = await setup();
  try {
    const id = mustPropose(fx, [EDIT]);
    await writeFile(path.join(fx.root, "AGENTS.md"), `${ORIGINAL}- more\n`);
    await scanProject(fx.store, fx.projectId, "test");
    const r = approveProposal(fx.store, { proposalId: id, confirmCode: confirmationCode(fx.store.getProposal(id)!.body), decidedBy: "u" });
    assert.ok(!r.ok && r.error.code === "stale_version");
  } finally {
    await fx.cleanup();
  }
});

test("a failed write leaves the original intact and requires re-approval", { skip: process.getuid?.() === 0 ? "root ignores permissions" : false }, async () => {
  const fx = await setup();
  try {
    const id = mustPropose(fx, [EDIT]);
    approve(fx, id);
    await chmod(fx.root, 0o555);
    let r;
    try {
      r = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    } finally {
      await chmod(fx.root, 0o755);
    }
    assert.ok(!r.ok && r.error.code === "write_failed", JSON.stringify(r));
    assert.equal(await readRoot(fx), ORIGINAL);
    assert.equal(fx.store.getProposal(id)?.status, "pending");
    assert.equal(fx.store.getActiveApproval(id), null);
    approve(fx, id);
    const retry = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    assert.ok(retry.ok);
  } finally {
    await fx.cleanup();
  }
});

test("a file swapped for a symlink after approval is refused and the target is untouched", async () => {
  const fx = await setup();
  try {
    const id = mustPropose(fx, [EDIT]);
    approve(fx, id);
    const outside = path.join(path.dirname(fx.root), "outside.md");
    await writeFile(outside, ORIGINAL);
    await rm(path.join(fx.root, "AGENTS.md"));
    await symlink(outside, path.join(fx.root, "AGENTS.md"));
    const r = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    assert.ok(!r.ok && r.error.code === "path_rejected");
    assert.equal(await readFile(outside, "utf8"), ORIGINAL);
  } finally {
    await fx.cleanup();
  }
});

test("CRLF, BOM and missing trailing newline are preserved; mixed line endings are refused", async () => {
  const crlf = await setup("\uFEFF# Root\r\n- Use npm to run scripts.\r\n- Keep commits small.");
  try {
    const id = mustPropose(crlf, [EDIT]);
    approve(crlf, id);
    assert.ok((await applyApprovedProposal(crlf.store, { proposalId: id, actor: "u" })).ok);
    assert.equal(await readRoot(crlf), "\uFEFF# Root\r\n- Use pnpm to run scripts.\r\n- Keep commits small.");
  } finally {
    await crlf.cleanup();
  }
  const mixed = await setup("# Root\r\n- Use npm to run scripts.\n- Keep commits small.\n");
  try {
    const id = mustPropose(mixed, [EDIT]);
    approve(mixed, id);
    const r = await applyApprovedProposal(mixed.store, { proposalId: id, actor: "u" });
    assert.ok(!r.ok && r.error.code === "unsupported_text");
    assert.equal(await readRoot(mixed), "# Root\r\n- Use npm to run scripts.\n- Keep commits small.\n");
  } finally {
    await mixed.cleanup();
  }
});

test("rejected proposals cannot be approved or applied", async () => {
  const fx = await setup();
  try {
    const id = mustPropose(fx, [EDIT]);
    assert.ok(rejectProposal(fx.store, { proposalId: id, decidedBy: "u" }).ok);
    const r = approveProposal(fx.store, { proposalId: id, confirmCode: confirmationCode(fx.store.getProposal(id)!.body), decidedBy: "u" });
    assert.ok(!r.ok && r.error.code === "not_pending");
    assert.equal(await readRoot(fx), ORIGINAL);
  } finally {
    await fx.cleanup();
  }
});

test("review diff uses valid unified hunk headers, including context and line shifts", async () => {
  const { renderDiff } = await import("../src/core/proposals.ts");
  const lines = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const diff = renderDiff("X.md", lines, [
    { startLine: 2, endLine: 2, expectedText: "b", replacementLines: ["b1", "b2"] },
    { startLine: 7, endLine: 7, expectedText: "g", replacementLines: ["g1"] },
  ]);
  assert.equal(diff, ["--- a/X.md", "+++ b/X.md", "@@ -1,4 +1,5 @@", " a", "-b", "+b1", "+b2", " c", " d", "@@ -5,4 +6,4 @@", " e", " f", "-g", "+g1", " h"].join("\n"));
});
