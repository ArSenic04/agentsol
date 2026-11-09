import { isSourceId, isVersionId, type ProjectId } from "./ids.ts";
import { sha256Hex } from "./hash.ts";
import { err, ok, type Result } from "./result.ts";
import type { EvidenceSpan } from "./schemas.ts";
import type { WorkspaceStore } from "./store.ts";
import { normalizeQuote } from "./text.ts";

export type EvidenceErrorCode = "bad_id" | "unknown_source" | "wrong_project" | "source_missing" | "stale_version" | "line_range" | "quote_mismatch";
export type EvidenceError = { readonly code: EvidenceErrorCode; readonly message: string };
export type QuotedSpan = { sourceId: string; versionId: string; startLine: number; endLine: number; quote: string };

/**
 * A client-quoted span is accepted only if it names a source of this project, the
 * source's CURRENT version, an in-bounds line range, and the exact (redacted) text.
 */
export function validateQuotedSpan(store: WorkspaceStore, projectId: ProjectId, q: QuotedSpan): Result<EvidenceSpan, EvidenceError> {
  if (!isSourceId(q.sourceId) || !isVersionId(q.versionId)) return err({ code: "bad_id", message: "sourceId/versionId are malformed" });
  const source = store.getSource(q.sourceId);
  if (!source) return err({ code: "unknown_source", message: `Unknown source ${q.sourceId}` });
  if (source.projectId !== projectId) return err({ code: "wrong_project", message: "Source belongs to a different project" });
  if (source.status !== "present" || !source.currentVersionId) return err({ code: "source_missing", message: "Source is no longer present on disk; rescan" });
  if (source.currentVersionId !== q.versionId) {
    return err({ code: "stale_version", message: `Version ${q.versionId} is not current (current is ${source.currentVersionId}); re-read the source` });
  }
  const version = store.getVersion(q.versionId);
  if (!version) return err({ code: "unknown_source", message: "Version not found" });
  if (q.startLine < 1 || q.endLine < q.startLine || q.endLine > version.lineCount) {
    return err({ code: "line_range", message: `Lines ${q.startLine}-${q.endLine} are outside 1-${version.lineCount}` });
  }
  const actual = version.lines.slice(q.startLine - 1, q.endLine).join("\n");
  if (normalizeQuote(q.quote) !== actual) {
    return err({ code: "quote_mismatch", message: `Quote does not match lines ${q.startLine}-${q.endLine} of ${source.relPath} exactly` });
  }
  return ok({ sourceId: source.id, versionId: version.id, relPath: source.relPath, startLine: q.startLine, endLine: q.endLine, textSha256: sha256Hex(actual) });
}
