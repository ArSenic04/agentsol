/**
 * HUMAN-ONLY approval and apply. This module must never be imported by the MCP
 * server (a test enforces that). Only the local CLI, driven by a person at a TTY,
 * may call it.
 *
 * Trust boundary: the MCP tool surface is the boundary. Any process running as the
 * same OS user (including a coding agent with shell access) can read the workspace
 * and drive this CLI through a pseudo-terminal; the CLI refuses known agent
 * environments, but that is a guard against accidents and prompt injection, not an
 * authentication mechanism.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFileInsideRoot } from "./fsSafe.ts";
import { sha256Hex } from "./hash.ts";
import type { ApprovalId, ProposalId, VersionId } from "./ids.ts";
import { LIMITS } from "./limits.ts";
import { resolveExistingInsideRoot } from "./paths.ts";
import { checkRootIdentity, verifyRegisteredRoot } from "./projectRoots.ts";
import { applyLineEdits, proposalDigest } from "./proposals.ts";
import { err, ok, type Result } from "./result.ts";
import { versionInputFromText } from "./scan.ts";
import type { WorkspaceStore } from "./store.ts";
import { decodeUtf8Strict, fromShape, toShape } from "./text.ts";

/** Short fingerprint of the exact proposal a human reviewed (shown by `review`). */
export const proposalFingerprint = (proposalSha256: string): string => proposalSha256.slice(0, 12);

export type ApprovalErrorCode = "unknown_proposal" | "not_pending" | "not_reviewed" | "stale_version" | "tampered" | "already_approved";
export type ApprovalError = { readonly code: ApprovalErrorCode; readonly message: string };

/**
 * Records a human approval for the exact proposal digest the human reviewed. All checks
 * and the insert run in one IMMEDIATE transaction; a partial unique index allows at
 * most one active approval per proposal.
 */
export function approveProposal(
  store: WorkspaceStore,
  args: { proposalId: ProposalId; reviewedProposalSha256: string; decidedBy: string; ttlMs?: number },
): Result<ApprovalId, ApprovalError> {
  return store.transaction((): Result<ApprovalId, ApprovalError> => {
    const stored = store.getProposal(args.proposalId);
    if (!stored) return err({ code: "unknown_proposal", message: "Unknown proposal" });
    const p = stored.body;
    if (stored.status !== "pending") return err({ code: "not_pending", message: `Proposal is ${stored.status}` });
    if (proposalDigest(p) !== p.proposalSha256) return err({ code: "tampered", message: "Stored proposal does not match its digest" });
    if (args.reviewedProposalSha256 !== p.proposalSha256) return err({ code: "not_reviewed", message: "The proposal differs from the one you reviewed; review it again" });
    const source = store.getSource(p.sourceId);
    if (!source || source.currentVersionId !== p.baseVersionId) return err({ code: "stale_version", message: "The source changed since this proposal was made; rescan and re-propose" });
    if (store.getActiveApproval(p.id)) return err({ code: "already_approved", message: "Proposal already has an active approval" });
    const a = store.insertApproval({ proposalId: p.id, proposalSha256: p.proposalSha256, baseRawSha256: p.baseRawSha256, decidedBy: args.decidedBy, ttlMs: args.ttlMs });
    store.audit({ actor: args.decidedBy, action: "proposal_approved", entityId: p.id, detail: { approvalId: a.id, expiresAt: a.expiresAt } });
    return ok(a.id);
  });
}

export function rejectProposal(store: WorkspaceStore, args: { proposalId: ProposalId; decidedBy: string }): Result<true, ApprovalError> {
  return store.transaction((): Result<true, ApprovalError> => {
    const stored = store.getProposal(args.proposalId);
    if (!stored) return err({ code: "unknown_proposal", message: "Unknown proposal" });
    if (!store.transitionProposal(args.proposalId, "pending", "rejected")) return err({ code: "not_pending", message: `Proposal is ${stored.status}` });
    store.voidActiveApprovals(args.proposalId);
    store.audit({ actor: args.decidedBy, action: "proposal_rejected", entityId: args.proposalId });
    return ok(true);
  });
}

export type ApplyErrorCode =
  | "unknown_proposal" | "not_pending" | "no_approval" | "approval_expired" | "approval_mismatch" | "path_rejected"
  | "stale_on_disk" | "unsupported_text" | "edit_mismatch" | "backup_failed" | "write_failed" | "write_unverified";
export type ApplyError = { readonly code: ApplyErrorCode; readonly message: string };
export type ApplySuccess = { relPath: string; newVersionId: VersionId; backupPath: string };

/**
 * Applies a proposal that a human approved. The approval is consumed and an apply intent
 * recorded before any file work (single use; crash-recoverable with reconcile). The
 * file must still hash to the proposal's base version and be reachable through a
 * symlink-free path inside the root. Write: backup → temp file next to the target →
 * verify temp is inside the root → re-verify original → atomic rename → verify result.
 *
 * Irreducible limitation: Node has no renameat/openat, so a process that can rewrite
 * directories inside the project could swap a parent directory between the last check
 * and rename. The post-rename check detects that case and reports write_unverified.
 */
export async function applyApprovedProposal(
  store: WorkspaceStore,
  args: { proposalId: ProposalId; actor: string },
): Promise<Result<ApplySuccess, ApplyError>> {
  type Claim = { ok: true; approvalId: ApprovalId } | { ok: false; error: ApplyError };
  const claim = store.transaction((): Claim => {
    const stored = store.getProposal(args.proposalId);
    if (!stored) return { ok: false, error: { code: "unknown_proposal", message: "Unknown proposal" } };
    const p = stored.body;
    if (stored.status !== "pending") return { ok: false, error: { code: "not_pending", message: `Proposal is ${stored.status}` } };
    const approval = store.getActiveApproval(p.id);
    if (!approval) return { ok: false, error: { code: "no_approval", message: "No active human approval for this proposal" } };
    if (approval.proposalSha256 !== p.proposalSha256 || approval.baseRawSha256 !== p.baseRawSha256 || proposalDigest(p) !== p.proposalSha256) {
      store.voidActiveApprovals(p.id);
      store.audit({ actor: args.actor, action: "approval_voided", entityId: p.id, detail: { reason: "mismatch" } });
      return { ok: false, error: { code: "approval_mismatch", message: "Approval does not match this exact proposal; approve again" } };
    }
    if (!store.consumeApproval(approval.id)) {
      store.voidActiveApprovals(p.id);
      store.audit({ actor: args.actor, action: "approval_voided", entityId: p.id, detail: { reason: "expired" } });
      return { ok: false, error: { code: "approval_expired", message: "Approval expired; approve again" } };
    }
    if (!store.transitionProposal(p.id, "pending", "applying")) return { ok: false, error: { code: "not_pending", message: "Proposal changed state" } };
    store.insertApplyIntent({ proposalId: p.id, approvalId: approval.id, baseRawSha256: p.baseRawSha256 });
    store.audit({ actor: args.actor, action: "apply_started", entityId: p.id, detail: { approvalId: approval.id } });
    return { ok: true, approvalId: approval.id };
  });
  if (!claim.ok) return err(claim.error);
  const stored = store.getProposal(args.proposalId);
  if (!stored) return err({ code: "unknown_proposal", message: "Unknown proposal" });
  const p = stored.body;

  const fail = (e: ApplyError, nextStatus: "pending" | "stale"): Result<ApplySuccess, ApplyError> => {
    store.transaction(() => {
      store.transitionProposal(p.id, "applying", nextStatus);
      store.audit({ actor: args.actor, action: "apply_failed", entityId: p.id, detail: { code: e.code } });
    });
    return err(e);
  };

  const project = store.getProject(p.projectId);
  const source = store.getSource(p.sourceId);
  if (!project || !source) return fail({ code: "path_rejected", message: "Project or source not found" }, "pending");
  const root = await verifyRegisteredRoot(project.rootReal);
  if (!root.ok) return fail({ code: "path_rejected", message: root.error }, "pending");
  const identity = await checkRootIdentity(project.rootReal, store.getRootObservation(project.id));
  if (!identity.ok) return fail({ code: "path_rejected", message: identity.error }, "pending");
  const read = await readFileInsideRoot(project.rootReal, p.relPath, LIMITS.maxFileBytes);
  if (!read.ok) return fail({ code: "path_rejected", message: read.error.message }, "pending");
  if (sha256Hex(read.value.bytes) !== p.baseRawSha256) {
    return fail({ code: "stale_on_disk", message: "File changed on disk since the proposal was made; nothing was written" }, "stale");
  }
  const decoded = decodeUtf8Strict(read.value.bytes);
  if (!decoded.ok) return fail({ code: "unsupported_text", message: decoded.error.message }, "pending");
  const shape = toShape(decoded.value);
  if (shape.mixedLineEndings) return fail({ code: "unsupported_text", message: "File mixes CRLF and LF line endings; not edited" }, "pending");
  const edited = applyLineEdits(shape.lines, p.edits);
  if (!edited.ok) return fail({ code: "edit_mismatch", message: edited.error.map((e) => e.message).join("; ") }, "pending");
  const newText = fromShape({ ...shape, lines: edited.value });
  const newBytes = Buffer.from(newText, "utf8");
  const newSha = sha256Hex(newBytes);
  store.transaction(() => store.setApplyIntentExpected(p.id, newSha));

  const backupPath = path.join(store.backupDir, `${p.id}-${p.baseRawSha256.slice(0, 12)}-${randomBytes(4).toString("hex")}.bak`);
  try {
    await mkdir(store.backupDir, { recursive: true, mode: 0o700 });
    await writeFile(backupPath, read.value.bytes, { flag: "wx", mode: 0o600 });
  } catch {
    return fail({ code: "backup_failed", message: "Could not write a backup; nothing was changed" }, "pending");
  }

  const relDir = path.posix.dirname(p.relPath);
  const tmpName = `.${path.posix.basename(p.relPath)}.agentsol-${randomBytes(6).toString("hex")}.tmp`;
  const tmpRel = relDir === "." ? tmpName : `${relDir}/${tmpName}`;
  const tmpPath = path.join(path.dirname(read.value.absPath), tmpName);
  let tmpIno: number;
  try {
    const handle = await open(tmpPath, "wx", read.value.mode);
    try {
      await handle.writeFile(newBytes);
      await handle.sync();
      tmpIno = (await handle.stat()).ino;
    } finally {
      await handle.close();
    }
  } catch {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    return fail({ code: "write_failed", message: "Could not write the file; the original is unchanged" }, "pending");
  }
  const cleanupTmp = () => rm(tmpPath, { force: true }).catch(() => undefined);
  const tmpCheck = await resolveExistingInsideRoot(project.rootReal, tmpRel);
  if (!tmpCheck.ok || (await lstat(tmpCheck.value)).ino !== tmpIno) {
    await cleanupTmp();
    return fail({ code: "path_rejected", message: "Target directory changed during apply; nothing was written" }, "pending");
  }
  const recheck = await readFileInsideRoot(project.rootReal, p.relPath, LIMITS.maxFileBytes);
  if (!recheck.ok || recheck.value.ino !== read.value.ino || sha256Hex(recheck.value.bytes) !== p.baseRawSha256) {
    await cleanupTmp();
    return fail({ code: "stale_on_disk", message: "File changed during apply; nothing was written" }, "stale");
  }
  try {
    await rename(tmpPath, read.value.absPath);
  } catch {
    await cleanupTmp();
    return fail({ code: "write_failed", message: "Could not write the file; the original is unchanged" }, "pending");
  }
  await syncDir(path.dirname(read.value.absPath));
  const after = await readFileInsideRoot(project.rootReal, p.relPath, LIMITS.maxFileBytes);
  if (!after.ok || after.value.ino !== tmpIno || sha256Hex(after.value.bytes) !== newSha) {
    store.transaction(() => {
      store.transitionProposal(p.id, "applying", "stale");
      store.audit({ actor: args.actor, action: "apply_unverified", entityId: p.id, detail: { backupPath } });
    });
    return err({ code: "write_unverified", message: `The write could not be verified at ${p.relPath}; check the file and the backup at ${backupPath}` });
  }

  const newVersionId = store.transaction(() => {
    const { version } = store.recordVersion({
      projectId: p.projectId,
      relPath: p.relPath,
      format: source.format,
      version: versionInputFromText({ text: newText, rawSha256: newSha, byteLength: newBytes.length, origin: "apply" }),
    });
    store.transitionProposal(p.id, "applying", "applied");
    store.audit({ actor: args.actor, action: "proposal_applied", entityId: p.id, detail: { backupPath, newVersionId: version.id, approvalId: claim.approvalId } });
    return version.id;
  });
  return ok({ relPath: p.relPath, newVersionId, backupPath });
}

async function syncDir(dir: string): Promise<void> {
  try {
    const h = await open(dir, "r");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    // Best effort: some filesystems do not support fsync on directories.
  }
}

export type ReconcileOutcome = "applied" | "pending" | "stale" | "not_applying";

/**
 * Resolves a proposal left in "applying" (for example after a crash) by comparing the
 * file on disk with the recorded intent. Never writes project files.
 */
export async function reconcileProposal(store: WorkspaceStore, args: { proposalId: ProposalId; actor: string }): Promise<ReconcileOutcome> {
  const stored = store.getProposal(args.proposalId);
  if (!stored || stored.status !== "applying") return "not_applying";
  const p = stored.body;
  const intent = store.getApplyIntent(p.id);
  const project = store.getProject(p.projectId);
  const source = store.getSource(p.sourceId);
  const read = project ? await readFileInsideRoot(project.rootReal, p.relPath, LIMITS.maxFileBytes) : null;
  const sha = read?.ok ? sha256Hex(read.value.bytes) : null;
  const decoded = read?.ok ? decodeUtf8Strict(read.value.bytes) : null;
  const outcome: ReconcileOutcome =
    sha !== null && intent?.expectedNewSha256 === sha ? "applied" : sha !== null && sha === p.baseRawSha256 ? "pending" : "stale";
  store.transaction(() => {
    if (outcome === "applied" && read?.ok && decoded?.ok && source) {
      store.recordVersion({
        projectId: p.projectId, relPath: p.relPath, format: source.format,
        version: versionInputFromText({ text: decoded.value, rawSha256: sha ?? "", byteLength: read.value.bytes.length, origin: "apply" }),
      });
    }
    store.transitionProposal(p.id, "applying", outcome === "applied" && decoded?.ok ? "applied" : outcome === "applied" ? "stale" : outcome);
    store.audit({ actor: args.actor, action: "apply_reconciled", entityId: p.id, detail: { outcome } });
  });
  return outcome;
}
