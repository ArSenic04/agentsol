import type { ProjectId } from "./ids.ts";
import type { Finding } from "./schemas.ts";
import type { WorkspaceStore } from "./store.ts";

/**
 * Findings whose evidence all points at current versions. Findings that cite an older
 * version are hidden by default (their quoted lines may no longer exist) and counted.
 */
export function currentFindings(store: WorkspaceStore, projectId: ProjectId, kind?: Finding["kind"]): { findings: Finding[]; staleHidden: number } {
  const current = new Map(store.listSources(projectId).filter((s) => s.status === "present").map((s) => [s.id, s.currentVersionId]));
  const findings: Finding[] = [];
  let staleHidden = 0;
  for (const f of store.listFindings(projectId, kind)) {
    if (f.evidence.every((e) => current.get(e.sourceId) === e.versionId)) findings.push(f);
    else staleHidden += 1;
  }
  return { findings, staleHidden };
}
