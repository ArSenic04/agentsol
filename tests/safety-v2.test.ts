// Tests for the architecture changes from the adversarial review: root validation,
// approval transactions/expiry, crash recovery, stale findings, and write verification.
import assert from "node:assert/strict";
import { link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { detectAgentEnvironment } from "../src/core/agentEnv.ts";
import { sanitizeForTerminal } from "../src/core/display.ts";
import { currentFindings } from "../src/core/findingsView.ts";
import { sha256Hex } from "../src/core/hash.ts";
import { applyApprovedProposal, approveProposal, reconcileProposal } from "../src/core/humanApproval.ts";
import type { ProposalId } from "../src/core/ids.ts";
import { validateProjectRoot } from "../src/core/projectRoots.ts";
import { proposeChange } from "../src/core/proposals.ts";
import { scanProject } from "../src/core/scan.ts";
import { submitSemanticFindings } from "../src/core/semantic.ts";
import { WorkspaceStore } from "../src/core/store.ts";
import { fixture, sourceByPath, tempDir, type Fixture } from "./helpers.ts";

const ORIGINAL = "# Root\n- Use npm to run scripts.\n";
const EDIT = { startLine: 2, endLine: 2, expectedText: "- Use npm to run scripts.", replacementLines: ["- Use pnpm to run scripts."] };

async function proposed(): Promise<{ fx: Fixture; id: ProposalId; sha: string }> {
  const fx = await fixture({ "AGENTS.md": ORIGINAL });
  await scanProject(fx.store, fx.projectId, "test");
  const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
  const r = proposeChange(fx.store, { projectId: fx.projectId, author: "a", input: { sourceId: source.id, baseVersionId: version.id, findingIds: [], rationale: "r", edits: [EDIT] } });
  assert.ok(r.ok);
  return { fx, id: r.value.proposal.id, sha: r.value.proposal.proposalSha256 };
}
const readRoot = (fx: Fixture) => readFile(path.join(fx.root, "AGENTS.md"), "utf8");

test("project roots: broad, sensitive, home-containing and workspace folders are refused", async () => {
  const base = await tempDir("roots");
  const home = path.join(base, "home");
  const dirs = ["Documents", "Library/App", "Projects/app", ".config/tool", "work/.ssh", "keys", "ws/inside", "Projects/app/sub"];
  for (const d of dirs) await mkdir(path.join(home, d), { recursive: true });
  const ws = path.join(home, "ws");
  const check = (c: string) => validateProjectRoot({ candidate: c, homeReal: home, workspaceDir: ws });
  for (const c of [home, base, path.join(home, "Documents"), path.join(home, "Library/App"), path.join(home, ".config/tool"), path.join(home, "work/.ssh"), path.join(home, "keys"), ws, path.join(ws, "inside"), "/", "/etc", "/usr/bin", path.join(home, "missing")]) {
    assert.equal((await check(c)).ok, false, c);
  }
  assert.deepEqual(await check(path.join(home, "Projects/app")), { ok: true, value: path.join(home, "Projects/app") });
  const linkRoot = path.join(base, "link-to-app");
  await symlink(path.join(home, "Projects/app"), linkRoot);
  assert.deepEqual(await check(linkRoot), { ok: true, value: path.join(home, "Projects/app") }, "a symlinked path registers its real target, never the link");
});

test("only one active approval can exist; concurrent connections cannot double-approve", async () => {
  const { fx, id, sha } = await proposed();
  try {
    const other = WorkspaceStore.open(fx.wsDir);
    try {
      assert.ok(approveProposal(fx.store, { proposalId: id, reviewedProposalSha256: sha, decidedBy: "u" }).ok);
      const second = approveProposal(other, { proposalId: id, reviewedProposalSha256: sha, decidedBy: "u" });
      assert.ok(!second.ok && second.error.code === "already_approved");
      assert.throws(() => other.insertApproval({ proposalId: id, proposalSha256: sha, baseRawSha256: "0".repeat(64), decidedBy: "raw" }), /UNIQUE/);
    } finally {
      other.close();
    }
  } finally {
    await fx.cleanup();
  }
});

test("expired approvals cannot be used and are voided", async () => {
  const { fx, id, sha } = await proposed();
  try {
    assert.ok(approveProposal(fx.store, { proposalId: id, reviewedProposalSha256: sha, decidedBy: "u", ttlMs: -1 }).ok);
    const r = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
    assert.ok(!r.ok && r.error.code === "approval_expired");
    assert.deepEqual(fx.store.listApprovals(id).map((a) => a.state), ["void"]);
    assert.equal(fx.store.getProposal(id)?.status, "pending");
    assert.equal(await readRoot(fx), ORIGINAL);
  } finally {
    await fx.cleanup();
  }
});

test("reconcile resolves a proposal left in 'applying' by a crash, without writing files", async () => {
  for (const crashedAfterRename of [true, false]) {
    const { fx, id, sha } = await proposed();
    try {
      const approvalId = approveProposal(fx.store, { proposalId: id, reviewedProposalSha256: sha, decidedBy: "u" });
      assert.ok(approvalId.ok);
      const body = fx.store.getProposal(id)!.body;
      const expected = "# Root\n- Use pnpm to run scripts.\n";
      fx.store.transaction(() => {
        fx.store.consumeApproval(approvalId.value);
        fx.store.transitionProposal(id, "pending", "applying");
        fx.store.insertApplyIntent({ proposalId: id, approvalId: approvalId.value, baseRawSha256: body.baseRawSha256 });
        fx.store.setApplyIntentExpected(id, sha256Hex(Buffer.from(expected)));
      });
      if (crashedAfterRename) await writeFile(path.join(fx.root, "AGENTS.md"), expected);
      const before = await readRoot(fx);
      const outcome = await reconcileProposal(fx.store, { proposalId: id, actor: "u" });
      assert.equal(outcome, crashedAfterRename ? "applied" : "pending");
      assert.equal(fx.store.getProposal(id)?.status, outcome);
      assert.equal(await readRoot(fx), before, "reconcile never writes");
      if (crashedAfterRename) assert.equal(sourceByPath(fx.store, fx.projectId, "AGENTS.md").version.rawSha256, sha256Hex(Buffer.from(expected)));
      else assert.equal(fx.store.getActiveApproval(id), null, "approval stays consumed; a person must approve again");
    } finally {
      await fx.cleanup();
    }
  }
});

test("apply refuses a target that became a hard link or whose root became a symlink", async () => {
  {
    const { fx, id, sha } = await proposed();
    try {
      assert.ok(approveProposal(fx.store, { proposalId: id, reviewedProposalSha256: sha, decidedBy: "u" }).ok);
      await link(path.join(fx.root, "AGENTS.md"), path.join(path.dirname(fx.root), "other-name.md"));
      const r = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
      assert.ok(!r.ok && r.error.code === "path_rejected", JSON.stringify(r));
      assert.equal(await readRoot(fx), ORIGINAL);
    } finally {
      await fx.cleanup();
    }
  }
  {
    const { fx, id, sha } = await proposed();
    try {
      assert.ok(approveProposal(fx.store, { proposalId: id, reviewedProposalSha256: sha, decidedBy: "u" }).ok);
      const moved = `${fx.root}-moved`;
      await rename(fx.root, moved);
      const decoy = path.join(path.dirname(fx.root), "decoy");
      await mkdir(decoy);
      await writeFile(path.join(decoy, "AGENTS.md"), ORIGINAL);
      await symlink(decoy, fx.root);
      const r = await applyApprovedProposal(fx.store, { proposalId: id, actor: "u" });
      assert.ok(!r.ok && r.error.code === "path_rejected");
      assert.equal(await readFile(path.join(decoy, "AGENTS.md"), "utf8"), ORIGINAL, "decoy outside the registered root is untouched");
    } finally {
      await fx.cleanup();
    }
  }
});

test("findings citing an older version are hidden from the current view", async () => {
  const fx = await fixture({ "AGENTS.md": ORIGINAL });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const r = submitSemanticFindings(fx.store, { projectId: fx.projectId, reporter: "t", findings: [{ checkId: "S03", title: "t", message: "m", severity: "info", confidence: "low", evidence: [{ sourceId: source.id, versionId: version.id, startLine: 2, endLine: 2, quote: "- Use npm to run scripts." }] }] });
    assert.equal(r.accepted.length, 1);
    assert.equal(currentFindings(fx.store, fx.projectId, "semantic").findings.length, 1);
    await writeFile(path.join(fx.root, "AGENTS.md"), "# Root\n- Use bun.\n");
    await scanProject(fx.store, fx.projectId, "test");
    assert.deepEqual(currentFindings(fx.store, fx.projectId, "semantic"), { findings: [], staleHidden: 1 });
  } finally {
    await fx.cleanup();
  }
});

test("proposals reject control characters in replacements and secrets in the rationale", async () => {
  const fx = await fixture({ "AGENTS.md": ORIGINAL });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const codes = (replacement: string, rationale = "r") => {
      const r = proposeChange(fx.store, { projectId: fx.projectId, author: "a", input: { sourceId: source.id, baseVersionId: version.id, findingIds: [], rationale, edits: [{ ...EDIT, replacementLines: [replacement] }] } });
      return r.ok ? ["ok"] : r.error.map((e) => e.code);
    };
    assert.deepEqual(codes("- Use pnpm \u001b[31m"), ["invalid_line"]);
    assert.deepEqual(codes("- Use pnpm \u202e"), ["invalid_line"]);
    assert.deepEqual(codes("- Use pnpm", "token = ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE"), ["secret_in_text"]);
    assert.deepEqual(codes("- Use pnpm\tto run scripts."), ["ok"]);
  } finally {
    await fx.cleanup();
  }
});

test("agent environment markers and terminal sanitizing", () => {
  assert.equal(detectAgentEnvironment({}), null);
  assert.equal(detectAgentEnvironment({ CLAUDECODE: "1" }), null, "CLAUDECODE alone is also set in IDE terminals used by people");
  assert.equal(detectAgentEnvironment({ CLAUDE_CODE_CHILD_SESSION: "1" })?.agent, "Claude Code");
  assert.equal(detectAgentEnvironment({ AI_AGENT: "false" }), null);
  assert.equal(sanitizeForTerminal("a\u001b[2Jb\tc\u2066"), "a\\u{1b}[2Jb\tc\\u{2066}");
});
