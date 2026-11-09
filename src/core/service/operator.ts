/**
 * HUMAN operator service, used only by the local CLI. It wraps registration (with root
 * validation), review, approval, rejection, apply and reconcile. It imports
 * humanApproval.ts and must never be reachable from src/mcp (a test walks the graph).
 * Messages here may include local absolute paths (for example a backup path) because
 * they are shown only to the person at the terminal.
 */
import { renderDiff } from "../proposals.ts";
import { applyApprovedProposal, approveProposal, proposalFingerprint, reconcileProposal, rejectProposal, type ReconcileOutcome } from "../humanApproval.ts";
import { isProposalId, type ApprovalId, type ProposalId } from "../ids.ts";
import { rootIdentity, validateProjectRoot } from "../projectRoots.ts";
import { ok, err, type Result } from "../result.ts";
import { scanProject } from "../scan.ts";
import type { AuditEvent, Project, StoredProposal, WorkspaceStore } from "../store.ts";

export type OperatorError = { readonly code: string; readonly message: string };
export type OperatorResult<T> = Result<T, OperatorError>;

export type Review = { proposal: StoredProposal; diff: string; fingerprint: string; baseIsCurrent: boolean; linkedFindings: string[] };

export function createOperatorService(store: WorkspaceStore, opts: { actor: () => string; homeReal: string }) {
  const proposal = (id: string): OperatorResult<StoredProposal> => {
    const p = isProposalId(id) ? store.getProposal(id) : null;
    return p ? ok(p) : err({ code: "not_found", message: "Unknown proposal" });
  };
  return Object.freeze({
    /**
     * Registers a folder and records its identity (device, inode). Registering an
     * already-registered path again is how a person re-confirms a folder that was
     * replaced at the same path; scans and applies refuse until then.
     */
    async registerProject(candidate: string, name?: string): Promise<OperatorResult<{ project: Project; alreadyRegistered: boolean; reconfirmed: boolean }>> {
      const checked = await validateProjectRoot({ candidate, homeReal: opts.homeReal, workspaceDir: store.dir });
      if (!checked.ok) return err({ code: "refused", message: checked.error });
      const identity = await rootIdentity(checked.value);
      if (!identity.ok) return err({ code: "refused", message: identity.error });
      const existing = store.findProjectByRoot(checked.value);
      if (existing) {
        const recorded = store.getRootObservation(existing.id);
        const replaced = recorded !== null && (recorded.dev !== identity.value.dev || recorded.ino !== identity.value.ino);
        if (replaced || recorded === null) {
          store.transaction(() => {
            store.putRootObservation(existing.id, identity.value);
            if (replaced) store.audit({ actor: opts.actor(), action: "project_root_reconfirmed", entityId: existing.id, detail: { previous: recorded, now: identity.value } });
          });
        }
        return ok({ project: existing, alreadyRegistered: true, reconfirmed: replaced });
      }
      const project = store.transaction(() => {
        const p = store.addProject({ name: (name ?? checked.value.split("/").pop() ?? "project").slice(0, 80), rootReal: checked.value });
        store.putRootObservation(p.id, identity.value);
        store.audit({ actor: opts.actor(), action: "project_registered", entityId: p.id });
        return p;
      });
      return ok({ project, alreadyRegistered: false, reconfirmed: false });
    },

    listProjectsWithRoots: (): Project[] => store.listProjects(),

    review(id: string): OperatorResult<Review> {
      const p = proposal(id);
      if (!p.ok) return p;
      const base = store.getVersion(p.value.body.baseVersionId);
      const source = store.getSource(p.value.body.sourceId);
      return ok({
        proposal: p.value,
        diff: base ? renderDiff(p.value.body.relPath, base.lines, p.value.body.edits) : "(base version unavailable)",
        fingerprint: proposalFingerprint(p.value.body.proposalSha256),
        baseIsCurrent: source?.currentVersionId === p.value.body.baseVersionId,
        linkedFindings: p.value.body.findingIds,
      });
    },

    /** The caller must pass the digest of the exact proposal it rendered to the person. */
    approve(args: { proposalId: ProposalId; reviewedProposalSha256: string }): OperatorResult<ApprovalId> {
      const r = approveProposal(store, { ...args, decidedBy: opts.actor() });
      return r.ok ? ok(r.value) : err(r.error);
    },

    reject(proposalId: ProposalId): OperatorResult<true> {
      const r = rejectProposal(store, { proposalId, decidedBy: opts.actor() });
      return r.ok ? ok(true) : err(r.error);
    },

    async apply(proposalId: ProposalId): Promise<OperatorResult<{ relPath: string; backupPath: string; rescanned: boolean }>> {
      const r = await applyApprovedProposal(store, { proposalId, actor: opts.actor() });
      if (!r.ok) return err(r.error);
      const p = store.getProposal(proposalId);
      const rescan = p ? await scanProject(store, p.body.projectId, opts.actor()) : null;
      return ok({ relPath: r.value.relPath, backupPath: r.value.backupPath, rescanned: rescan?.ok === true });
    },

    reconcile: (proposalId: ProposalId): Promise<ReconcileOutcome> => reconcileProposal(store, { proposalId, actor: opts.actor() }),

    audit: (entityId?: string): AuditEvent[] => store.listAudit(entityId),
  });
}

export type OperatorService = ReturnType<typeof createOperatorService>;
