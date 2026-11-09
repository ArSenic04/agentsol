/**
 * HUMAN-ONLY approval and apply. This module must never be imported by the MCP
 * server (a test enforces that). Only the local CLI, driven by a person at a TTY,
 * may call it.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRegularFileNoFollow } from "./fsSafe.ts";
import { sha256Hex } from "./hash.ts";
import type { ApprovalId, ProposalId, VersionId } from "./ids.ts";
import { LIMITS } from "./limits.ts";
import { resolveExistingInsideRoot } from "./paths.ts";
import { applyLineEdits, proposalDigest } from "./proposals.ts";
import { err, ok, type Result } from "./result.ts";
import { versionInputFromText } from "./scan.ts";
import type { ProposalBody } from "./schemas.ts";
import type { WorkspaceStore } from "./store.ts";
import { decodeUtf8Strict, fromShape, toShape } from "./text.ts";

/** The code a human must type to approve; derived from the exact proposal digest. */
export const confirmationCode = (p: ProposalBody): string => p.proposalSha256.slice(0, 12);

export type ApprovalErrorCode = "unknown_proposal" | "not_pending" | "confirm_mismatch" | "stale_version" | "tampered" | "already_approved";
export type ApprovalError = { readonly code: ApprovalErrorCode; readonly message: string };

export function approveProposal(
  store: WorkspaceStore,
  args: { proposalId: ProposalId; confirmCode: string; decidedBy: string },
): Result<ApprovalId, ApprovalError> {
  const stored = store.getProposal(args.proposalId);
  if (!stored) return err({ code: "unknown_proposal", message: "Unknown proposal" });
  const p = stored.body;
  if (stored.status !== "pending") return err({ code: "not_pending", message: `Proposal is ${stored.status}` });
  if (proposalDigest(p) !== p.proposalSha256) return err({ code: "tampered", message: "Stored proposal does not match its digest" });
  if (args.confirmCode.trim() !== confirmationCode(p)) return err({ code: "confirm_mismatch", message: "Confirmation code does not match this proposal" });
  const source = store.getSource(p.sourceId);
  if (!source || source.currentVersionId !== p.baseVersionId) return err({ code: "stale_version", message: "The source changed since this proposal was made; rescan and re-propose" });
  if (store.getActiveApproval(p.id)) return err({ code: "already_approved", message: "Proposal already has an active approval" });
  const approval = store.transaction(() => {
    const a = store.insertApproval({ proposalId: p.id, proposalSha256: p.proposalSha256, baseRawSha256: p.baseRawSha256, decidedBy: args.decidedBy });
    store.audit({ actor: args.decidedBy, action: "proposal_approved", entityId: p.id, detail: { approvalId: a.id } });
    return a;
  });
  return ok(approval.id);
}

export function rejectProposal(store: WorkspaceStore, args: { proposalId: ProposalId; decidedBy: string }): Result<true, ApprovalError> {
  const stored = store.getProposal(args.proposalId);
  if (!stored) return err({ code: "unknown_proposal", message: "Unknown proposal" });
  const done = store.transaction(() => {
    if (!store.transitionProposal(args.proposalId, "pending", "rejected")) return false;
    store.voidActiveApprovals(args.proposalId);
    store.audit({ actor: args.decidedBy, action: "proposal_rejected", entityId: args.proposalId });
    return true;
  });
  return done ? ok(true) : err({ code: "not_pending", message: `Proposal is ${stored.status}` });
}

export type ApplyErrorCode =
  | "unknown_proposal" | "not_pending" | "no_approval" | "approval_mismatch" | "path_rejected"
  | "stale_on_disk" | "unsupported_text" | "edit_mismatch" | "backup_failed" | "write_failed";
export type ApplyError = { readonly code: ApplyErrorCode; readonly message: string };
export type ApplySuccess = { relPath: string; newVersionId: VersionId; backupPath: string };

/**
 * Applies a proposal that a human approved. The approval is consumed before any file
 * work (single use). The on-disk file must still hash to the proposal's base version.
 * Write is backup → temp file in same directory → re-verify → atomic rename.
 * On failure the original file is left untouched and the proposal needs re-approval.
 */
export async function applyApprovedProposal(
  store: WorkspaceStore,
  args: { proposalId: ProposalId; actor: string },
): Promise<Result<ApplySuccess, ApplyError>> {
  const stored = store.getProposal(args.proposalId);
  if (!stored) return err({ code: "unknown_proposal", message: "Unknown proposal" });
  const p = stored.body;
  if (stored.status !== "pending") return err({ code: "not_pending", message: `Proposal is ${stored.status}` });
  const approval = store.getActiveApproval(p.id);
  if (!approval) return err({ code: "no_approval", message: "No active human approval for this proposal" });
  if (approval.proposalSha256 !== p.proposalSha256 || approval.baseRawSha256 !== p.baseRawSha256 || proposalDigest(p) !== p.proposalSha256) {
    store.transaction(() => store.voidActiveApprovals(p.id));
    return err({ code: "approval_mismatch", message: "Approval does not match this exact proposal; approve again" });
  }
  const claimed = store.transaction(() => store.consumeApproval(approval.id) && store.transitionProposal(p.id, "pending", "applying"));
  if (!claimed) return err({ code: "no_approval", message: "Approval was already used" });

  const fail = (e: ApplyError, nextStatus: "pending" | "stale"): Result<ApplySuccess, ApplyError> => {
    store.transaction(() => {
      store.transitionProposal(p.id, "applying", nextStatus);
      store.audit({ actor: args.actor, action: "apply_failed", entityId: p.id, detail: e });
    });
    return err(e);
  };

  const project = store.getProject(p.projectId);
  const source = store.getSource(p.sourceId);
  if (!project || !source) return fail({ code: "path_rejected", message: "Project or source not found" }, "pending");
  const resolved = await resolveExistingInsideRoot(project.rootReal, p.relPath);
  if (!resolved.ok) return fail({ code: "path_rejected", message: resolved.error.message }, "pending");
  const absPath = resolved.value;
  const read = await readRegularFileNoFollow(absPath, LIMITS.maxFileBytes);
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

  const backupPath = path.join(store.backupDir, `${p.id}-${p.baseRawSha256.slice(0, 12)}-${randomBytes(4).toString("hex")}.bak`);
  try {
    await mkdir(store.backupDir, { recursive: true, mode: 0o700 });
    await writeFile(backupPath, read.value.bytes, { flag: "wx", mode: 0o600 });
  } catch {
    return fail({ code: "backup_failed", message: "Could not write a backup; nothing was changed" }, "pending");
  }

  const tmpPath = path.join(path.dirname(absPath), `.${path.basename(absPath)}.agentweave-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(tmpPath, "wx", read.value.mode);
    try {
      await handle.writeFile(newBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const recheck = await readRegularFileNoFollow(absPath, LIMITS.maxFileBytes);
    if (!recheck.ok || sha256Hex(recheck.value.bytes) !== p.baseRawSha256) {
      await rm(tmpPath, { force: true });
      return fail({ code: "stale_on_disk", message: "File changed during apply; nothing was written" }, "stale");
    }
    await rename(tmpPath, absPath);
  } catch {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    return fail({ code: "write_failed", message: "Could not write the file; the original is unchanged" }, "pending");
  }

  const newVersionId = store.transaction(() => {
    const { version } = store.recordVersion({
      projectId: p.projectId,
      relPath: p.relPath,
      format: source.format,
      version: versionInputFromText({ text: newText, rawSha256: sha256Hex(newBytes), byteLength: newBytes.length, origin: "apply" }),
    });
    store.transitionProposal(p.id, "applying", "applied");
    store.audit({ actor: args.actor, action: "proposal_applied", entityId: p.id, detail: { backupPath, newVersionId: version.id, approvalId: approval.id } });
    return version.id;
  });
  return ok({ relPath: p.relPath, newVersionId, backupPath });
}
