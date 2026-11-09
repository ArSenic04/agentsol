/**
 * Freshness: has anything AgentWeave already knows about changed on disk since the last
 * scan? Metadata only (lstat); file content is never read here.
 *
 * Limits, stated in every result:
 * - Equal metadata does NOT prove equal content (a tool can restore size and mtime).
 *   Evidence checks and apply always compare byte hashes; they never use this module.
 * - Only files recorded by the last scan are checked. New instruction files, and files
 *   that were excluded (symlinks, case variants, skipped folders), are not detected
 *   until the next scan.
 */
import { lstat } from "node:fs/promises";
import { fileMetaFrom, type FileMeta } from "./fileMeta.ts";
import type { ProjectId } from "./ids.ts";
import { resolveExistingInsideRoot } from "./paths.ts";
import { verifyRegisteredRoot } from "./projectRoots.ts";
import type { WorkspaceStore } from "./store.ts";

export type SourceFreshnessState =
  /** lstat metadata equals what was recorded at scan time. Not proof the content is unchanged. */
  | "metadata_unchanged"
  /** Size, modification/change time, inode or device differ: the file was very likely rewritten. */
  | "changed"
  /** The recorded file no longer exists at its path. */
  | "removed"
  /** The path is now a symlink, not a regular file, has extra hard links, or escapes the root. AgentWeave will not read it. */
  | "unsafe"
  /** Could not be checked (no metadata from the last scan, or the check itself failed). */
  | "unknown";

export type SourceFreshness = { sourceId: string; relPath: string; state: SourceFreshnessState };

export type FreshnessCounts = Record<SourceFreshnessState, number>;

export type ProjectFreshness =
  | { state: "not_checked"; reason: "never_scanned" }
  | { state: "unknown"; reason: "root_unavailable" | "root_replaced" | "no_root_metadata"; checkedAt: string }
  | {
      /** changes_detected: at least one changed/removed/unsafe; incomplete: some unknown, none changed; no_known_changes: metadata matched for every recorded file. */
      state: "changes_detected" | "incomplete" | "no_known_changes";
      checkedAt: string;
      counts: FreshnessCounts;
    };

export const FRESHNESS_CAVEATS = [
  "Freshness compares file metadata (size, timestamps, inode) recorded at the last scan with the disk now; file content is not read.",
  "Matching metadata does not prove a file is unchanged. Proposals and evidence are always checked against byte hashes, never metadata.",
  "Only files recorded by the last scan are checked. New instruction files are not detected until you scan again.",
];

const emptyCounts = (): FreshnessCounts => ({ metadata_unchanged: 0, changed: 0, removed: 0, unsafe: 0, unknown: 0 });

/** Pure comparison. Equal metadata returns "metadata_unchanged", which is a hint, not a proof. */
export function compareMeta(recorded: FileMeta, now: FileMeta): "metadata_unchanged" | "changed" | "unsafe" {
  if (now.nlink !== "1") return "unsafe";
  const same = recorded.dev === now.dev && recorded.ino === now.ino && recorded.size === now.size && recorded.mtimeNs === now.mtimeNs && recorded.ctimeNs === now.ctimeNs;
  return same ? "metadata_unchanged" : "changed";
}

async function observe(rootReal: string, relPath: string): Promise<"removed" | "unsafe" | "unknown" | { meta: FileMeta }> {
  const resolved = await resolveExistingInsideRoot(rootReal, relPath);
  if (!resolved.ok) return resolved.error.code === "not_found" ? "removed" : "unsafe";
  try {
    const st = await lstat(resolved.value, { bigint: true });
    if (!st.isFile()) return "unsafe";
    return { meta: fileMetaFrom(st) };
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "ENOENT" ? "removed" : "unknown";
  }
}

/** Checks every source the last scan recorded as present. Never reads file content. */
export async function checkFreshness(store: WorkspaceStore, projectId: ProjectId): Promise<{ project: ProjectFreshness; sources: SourceFreshness[] } | null> {
  const project = store.getProject(projectId);
  if (!project) return null;
  if (!store.getScan(projectId)) return { project: { state: "not_checked", reason: "never_scanned" }, sources: [] };
  const checkedAt = new Date().toISOString();
  const root = await verifyRegisteredRoot(project.rootReal);
  if (!root.ok) return { project: { state: "unknown", reason: "root_unavailable", checkedAt }, sources: [] };
  const recordedRoot = store.getRootObservation(projectId);
  if (!recordedRoot) return { project: { state: "unknown", reason: "no_root_metadata", checkedAt }, sources: [] };
  try {
    const st = await lstat(project.rootReal, { bigint: true });
    if (st.dev.toString() !== recordedRoot.dev || st.ino.toString() !== recordedRoot.ino) {
      return { project: { state: "unknown", reason: "root_replaced", checkedAt }, sources: [] };
    }
  } catch {
    return { project: { state: "unknown", reason: "root_unavailable", checkedAt }, sources: [] };
  }

  const counts = emptyCounts();
  const sources: SourceFreshness[] = [];
  for (const s of store.listSources(projectId)) {
    if (s.status !== "present") continue;
    const recorded = store.getObservation(s.id);
    let state: SourceFreshnessState;
    if (!recorded || recorded.versionId !== s.currentVersionId) state = "unknown";
    else {
      const now = await observe(project.rootReal, s.relPath);
      state = typeof now === "string" ? now : compareMeta(recorded.meta, now.meta);
    }
    counts[state] += 1;
    sources.push({ sourceId: s.id, relPath: s.relPath, state });
  }
  const state = counts.changed + counts.removed + counts.unsafe > 0 ? "changes_detected" : counts.unknown > 0 ? "incomplete" : "no_known_changes";
  return { project: { state, checkedAt, counts }, sources };
}
