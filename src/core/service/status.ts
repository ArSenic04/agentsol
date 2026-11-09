import { currentFindings } from "../findingsView.ts";
import { checkFreshness, FRESHNESS_CAVEATS, type ProjectFreshness } from "../freshness.ts";
import type { ProjectId } from "../ids.ts";
import type { WorkspaceStore } from "../store.ts";

export type ScanState =
  | { state: "never_scanned" }
  | { state: "refused"; at: string; reason: string }
  | { state: "scanned"; at: string; partial: boolean; partialReasons: string[] };

export type ProjectStatus = {
  projectId: ProjectId;
  name: string;
  scan: ScanState;
  sources: { present: number; missing: number; withRedactedLines: number };
  notRead: { total: number; byReason: Record<string, number> };
  /** Counted from the last scan's snapshot, not re-checked against the disk. */
  findings: { basis: "last_scan_snapshot"; structural: number; semantic: number; staleHidden: number };
  proposals: { pending: number; pendingOnOldVersion: number; applying: number; stale: number; applied: number; rejected: number };
  /** Observed on disk now (metadata only). Independent of scan.partial. */
  freshness: ProjectFreshness;
};

export type WorkspaceStatus = { projects: ProjectStatus[]; caveats: string[] };

export const STATUS_CAVEATS = [
  "Only files named AGENTS.md, AGENTS.override.md, CLAUDE.md (including .claude/CLAUDE.md) and SKILL.md are inspected. Zero findings does not mean the instructions are correct or complete.",
  "User-level, managed, .claude/rules, .cursor/rules files and @import targets are not inspected.",
  "Findings that cite older file versions are counted in staleHidden and not shown as current.",
  "Sources, findings and proposal counts are a snapshot of the last scan. 'freshness' is what was observed on disk when you asked; 'scan.partial' is about what the last scan could not cover. They are separate.",
  ...FRESHNESS_CAVEATS,
];

type Skipped = { secretLike?: number; symlinks?: number; unreadableDirs?: number; skippedDirs?: number; depthLimited?: number; limitReached?: boolean };

function partialReasons(skipped: Skipped, byReason: Record<string, number>): string[] {
  const r: string[] = [];
  if (skipped.limitReached) r.push("Directory entry limit reached; the rest of the project was not scanned");
  if ((skipped.depthLimited ?? 0) > 0) r.push(`${skipped.depthLimited} folder(s) deeper than the depth limit were not scanned`);
  if ((skipped.unreadableDirs ?? 0) > 0) r.push(`${skipped.unreadableDirs} folder(s) could not be read`);
  if ((skipped.skippedDirs ?? 0) > 0) r.push(`${skipped.skippedDirs} generated or dependency folder(s) (node_modules, dist, build, ...) were not scanned`);
  if ((skipped.secretLike ?? 0) > 0) r.push(`${skipped.secretLike} secret-like name(s) were not opened`);
  if ((skipped.symlinks ?? 0) > 0) r.push(`${skipped.symlinks} symlink(s) were not followed`);
  const notRead = Object.entries(byReason).filter(([, n]) => n > 0).map(([k, n]) => `${n} instruction file(s) not read (${k})`);
  return [...r, ...notRead];
}

/** Read-only status. Contains no file text and no absolute paths. */
export async function projectStatus(store: WorkspaceStore, projectId: ProjectId): Promise<ProjectStatus | null> {
  const project = store.getProject(projectId);
  if (!project) return null;
  const sources = store.listSources(projectId);
  const present = sources.filter((s) => s.status === "present");
  const withRedactedLines = present.filter((s) => {
    const v = s.currentVersionId ? store.getVersion(s.currentVersionId) : null;
    return (v?.redactedLineNumbers.length ?? 0) > 0;
  }).length;
  const byReason: Record<string, number> = {};
  for (const e of store.listExclusions(projectId)) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  const scanRow = store.getScan(projectId);
  let scan: ScanState;
  if (!scanRow) scan = { state: "never_scanned" };
  else if (scanRow.outcome === "refused") {
    const reason = typeof scanRow.summary === "object" && scanRow.summary !== null && "reason" in scanRow.summary ? String(scanRow.summary.reason) : "refused";
    scan = { state: "refused", at: scanRow.at, reason };
  } else {
    const skipped: Skipped = typeof scanRow.summary === "object" && scanRow.summary !== null && "skipped" in scanRow.summary && typeof scanRow.summary.skipped === "object" && scanRow.summary.skipped !== null ? scanRow.summary.skipped : {};
    const reasons = partialReasons(skipped, byReason);
    scan = { state: "scanned", at: scanRow.at, partial: reasons.length > 0, partialReasons: reasons };
  }
  const structural = currentFindings(store, projectId, "structural");
  const semantic = currentFindings(store, projectId, "semantic");
  const current = new Map(present.map((s) => [s.id, s.currentVersionId]));
  const proposals = { pending: 0, pendingOnOldVersion: 0, applying: 0, stale: 0, applied: 0, rejected: 0 };
  for (const p of store.listProposals(projectId)) {
    proposals[p.status] += 1;
    if (p.status === "pending" && current.get(p.body.sourceId) !== p.body.baseVersionId) proposals.pendingOnOldVersion += 1;
  }
  return {
    projectId,
    name: project.name,
    scan,
    sources: { present: present.length, missing: sources.length - present.length, withRedactedLines },
    notRead: { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason },
    findings: { basis: "last_scan_snapshot", structural: structural.findings.length, semantic: semantic.findings.length, staleHidden: structural.staleHidden + semantic.staleHidden },
    proposals,
    freshness: (await checkFreshness(store, projectId))?.project ?? { state: "not_checked", reason: "never_scanned" },
  };
}

export async function workspaceStatus(store: WorkspaceStore): Promise<WorkspaceStatus> {
  const projects: ProjectStatus[] = [];
  for (const p of store.listProjects()) {
    const s = await projectStatus(store, p.id);
    if (s) projects.push(s);
  }
  return { projects, caveats: STATUS_CAVEATS };
}
