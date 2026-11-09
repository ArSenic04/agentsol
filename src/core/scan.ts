import { runStructuralChecks, type CheckSource } from "./checks.ts";
import { discover, type SkippedCounts } from "./discovery.ts";
import type { ProjectId } from "./ids.ts";
import { checkRootIdentity, verifyRegisteredRoot } from "./projectRoots.ts";
import { err, ok, type Result } from "./result.ts";
import { redactLines } from "./secrets.ts";
import type { NewVersionInput, VersionOrigin, WorkspaceStore } from "./store.ts";
import { toShape } from "./text.ts";

export function versionInputFromText(args: { text: string; rawSha256: string; byteLength: number; origin: VersionOrigin }): NewVersionInput {
  const { lines, redacted } = redactLines(toShape(args.text).lines);
  return { rawSha256: args.rawSha256, byteLength: args.byteLength, lines, redactedLineNumbers: redacted.map((r) => r.line), origin: args.origin };
}

export type ScanSummary = {
  projectId: ProjectId;
  sources: number;
  newVersions: number;
  missing: number;
  exclusions: number;
  skipped: SkippedCounts;
  structuralFindings: number;
};

/** Discover → record versions → deterministic checks, for one registered project. */
export async function scanProject(store: WorkspaceStore, projectId: ProjectId, actor: string): Promise<Result<ScanSummary, string>> {
  const project = store.getProject(projectId);
  if (!project) return err(`Unknown project ${projectId}`);
  const refuse = (reason: string): Result<ScanSummary, string> => {
    store.transaction(() => {
      store.recordScan(projectId, "refused", { reason });
      store.audit({ actor, action: "scan_refused", entityId: projectId, detail: { reason } });
    });
    return err(reason);
  };
  const root = await verifyRegisteredRoot(project.rootReal);
  if (!root.ok) return refuse(root.error);
  // The folder must still be the one a person registered (or last re-confirmed).
  const identity = await checkRootIdentity(project.rootReal, store.getRootObservation(projectId));
  if (!identity.ok) return refuse(identity.error);
  const found = await discover(project.rootReal);
  const after = await checkRootIdentity(project.rootReal, identity.value);
  if (!after.ok) return refuse(`The project folder changed while it was being scanned; nothing was recorded. ${after.error}`);
  let newVersions = 0;
  const missing = store.transaction(() => {
    for (const s of found.sources) {
      const recorded = store.recordVersion({
        projectId,
        relPath: s.relPath,
        format: s.format,
        version: versionInputFromText({ text: s.text, rawSha256: s.rawSha256, byteLength: s.byteLength, origin: "import" }),
      });
      const changed = recorded.changed;
      if (changed) newVersions += 1;
      store.putObservation(recorded.source.id, recorded.version.id, s.meta);
    }
    store.putRootObservation(projectId, identity.value);
    store.replaceExclusions(projectId, found.exclusions);
    store.recordScan(projectId, "ok", { sources: found.sources.length, exclusions: found.exclusions.length, skipped: found.skipped });
    const presentPaths = new Set(found.sources.map((s) => s.relPath));
    for (const s of store.listSources(projectId)) if (!presentPaths.has(s.relPath)) store.deleteObservation(s.id);
    return store.markMissingExcept(projectId, presentPaths);
  });
  const findings = await runChecksForProject(store, projectId);
  store.audit({ actor, action: "scan", entityId: projectId, detail: { sources: found.sources.length, newVersions, missing } });
  return ok({ projectId, sources: found.sources.length, newVersions, missing, exclusions: found.exclusions.length, skipped: found.skipped, structuralFindings: findings });
}

export function checkSourcesFor(store: WorkspaceStore, projectId: ProjectId): CheckSource[] {
  const out: CheckSource[] = [];
  for (const s of store.listSources(projectId)) {
    if (s.status !== "present" || !s.currentVersionId) continue;
    const v = store.getVersion(s.currentVersionId);
    if (!v) continue;
    out.push({ sourceId: s.id, versionId: v.id, relPath: s.relPath, format: s.format, lines: v.lines, redactedLineNumbers: v.redactedLineNumbers, byteLength: v.byteLength });
  }
  return out;
}

export async function runChecksForProject(store: WorkspaceStore, projectId: ProjectId): Promise<number> {
  const project = store.getProject(projectId);
  if (!project) return 0;
  const findings = await runStructuralChecks({ rootReal: project.rootReal, sources: checkSourcesFor(store, projectId) });
  store.transaction(() => store.replaceStructuralFindings(projectId, findings));
  return findings.length;
}
