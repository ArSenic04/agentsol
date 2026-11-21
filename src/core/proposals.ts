import { hasUnsafeTextChars } from "./display.ts";
import { z } from "zod";
import { sha256Hex } from "./hash.ts";
import { isFindingId, isSourceId, isVersionId, newProposalId, type FindingId, type ProjectId } from "./ids.ts";
import { LIMITS } from "./limits.ts";
import { err, ok, type Result } from "./result.ts";
import { LineEditSchema, type LineEdit, type ProposalBody } from "./schemas.ts";
import { containsSecretLike } from "./secrets.ts";
import type { WorkspaceStore } from "./store.ts";
import { normalizeQuote } from "./text.ts";

export const ProposeInputSchema = z.object({
  sourceId: z.string(),
  baseVersionId: z.string().describe("Current versionId of the source (from source_read)"),
  findingIds: z.array(z.string()).max(20).default([]),
  rationale: z.string().min(1).max(4_000),
  edits: z.array(LineEditSchema).min(1).max(50),
});
export type ProposeInput = z.infer<typeof ProposeInputSchema>;

export type ProposeErrorCode =
  | "bad_id" | "unknown_source" | "wrong_project" | "source_missing" | "stale_version" | "unknown_finding"
  | "line_range" | "overlap" | "expected_mismatch" | "redacted_line" | "invalid_line" | "secret_in_replacement" | "secret_in_text" | "too_large" | "no_change";
export type ProposeError = { readonly code: ProposeErrorCode; readonly message: string; readonly editIndex?: number };

/**
 * Applies line edits to a copy of `lines`. Each edit must match `expectedText`
 * exactly and edits may not overlap. Pure; used both for proposing and applying.
 */
export function applyLineEdits(lines: readonly string[], edits: readonly LineEdit[], redactedLines: ReadonlySet<number> = new Set()): Result<string[], ProposeError[]> {
  const errors: ProposeError[] = [];
  const order = edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.startLine - b.e.startLine);
  let prevEnd = 0;
  for (const { e, i } of order) {
    if (e.endLine < e.startLine || e.endLine > lines.length) {
      errors.push({ code: "line_range", message: `Lines ${e.startLine}-${e.endLine} are outside 1-${lines.length}`, editIndex: i });
      continue;
    }
    if (e.startLine <= prevEnd) errors.push({ code: "overlap", message: "Edits overlap", editIndex: i });
    prevEnd = Math.max(prevEnd, e.endLine);
    for (let n = e.startLine; n <= e.endLine; n += 1) {
      if (redactedLines.has(n)) {
        errors.push({ code: "redacted_line", message: `Line ${n} contains redacted secret-like text and cannot be edited through Agentsol`, editIndex: i });
        break;
      }
    }
    if (lines.slice(e.startLine - 1, e.endLine).join("\n") !== normalizeQuote(e.expectedText)) {
      errors.push({ code: "expected_mismatch", message: `expectedText does not match lines ${e.startLine}-${e.endLine}`, editIndex: i });
    }
    if (e.replacementLines.some((l) => /[\r\n\0]/.test(l) || hasUnsafeTextChars(l))) {
      errors.push({ code: "invalid_line", message: "replacementLines entries may not contain newlines, NUL, control characters or bidi overrides", editIndex: i });
    }
  }
  if (errors.length > 0) return err(errors);
  const out = [...lines];
  for (const { e } of [...order].reverse()) out.splice(e.startLine - 1, e.endLine - e.startLine + 1, ...e.replacementLines);
  return ok(out);
}

export const proposalDigest = (b: Omit<ProposalBody, "proposalSha256" | "createdAt" | "id" | "author" | "rationale" | "findingIds">): string =>
  sha256Hex(JSON.stringify({ v: 1, projectId: b.projectId, sourceId: b.sourceId, relPath: b.relPath, baseVersionId: b.baseVersionId, baseRawSha256: b.baseRawSha256, edits: b.edits }));

/** Human-reviewable unified diff of the proposed edits; edits whose context overlaps share one hunk. */
export function renderDiff(relPath: string, lines: readonly string[], edits: readonly LineEdit[]): string {
  const out = [`--- a/${relPath}`, `+++ b/${relPath}`];
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  const hunks: LineEdit[][] = [];
  for (const e of sorted) {
    const last = hunks.at(-1);
    const prev = last?.at(-1);
    if (last && prev && e.startLine - 2 <= prev.endLine + 2) last.push(e);
    else hunks.push([e]);
  }
  let delta = 0;
  for (const hunk of hunks) {
    const first = hunk[0]!;
    const lastEdit = hunk.at(-1)!;
    const ctxStart = Math.max(1, first.startLine - 2);
    const ctxEnd = Math.min(lines.length, lastEdit.endLine + 2);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let n = ctxStart;
    for (const e of hunk) {
      for (; n < e.startLine; n += 1) { body.push(` ${lines[n - 1] ?? ""}`); oldCount += 1; newCount += 1; }
      // Lines an edit keeps as they were (its anchor) show as context, not as removed and re-added.
      const old = lines.slice(e.startLine - 1, e.endLine);
      const rep = e.replacementLines;
      let p = 0;
      while (p < old.length && p < rep.length && old[p] === rep[p]) p += 1;
      let s = 0;
      while (s < old.length - p && s < rep.length - p && old[old.length - 1 - s] === rep[rep.length - 1 - s]) s += 1;
      for (const l of old.slice(0, p)) { body.push(` ${l}`); oldCount += 1; newCount += 1; }
      for (const l of old.slice(p, old.length - s)) { body.push(`-${l}`); oldCount += 1; }
      for (const r of rep.slice(p, rep.length - s)) { body.push(`+${r}`); newCount += 1; }
      for (const l of old.slice(old.length - s)) { body.push(` ${l}`); oldCount += 1; newCount += 1; }
      n = e.endLine + 1;
    }
    for (; n <= ctxEnd; n += 1) { body.push(` ${lines[n - 1] ?? ""}`); oldCount += 1; newCount += 1; }
    out.push(`@@ -${ctxStart},${oldCount} +${ctxStart + delta},${newCount} @@`, ...body);
    delta += newCount - oldCount;
  }
  return out.join("\n");
}

/**
 * Stores a proposed change. Never touches project files. The proposal is bound to the
 * source's current version and raw hash so it goes stale if the file changes.
 */
export function proposeChange(
  store: WorkspaceStore,
  args: { projectId: ProjectId; input: ProposeInput; author: string },
): Result<{ proposal: ProposalBody; diff: string; duplicate: boolean }, ProposeError[]> {
  const { input } = args;
  if (!isSourceId(input.sourceId) || !isVersionId(input.baseVersionId)) return err([{ code: "bad_id", message: "sourceId/baseVersionId are malformed" }]);
  const source = store.getSource(input.sourceId);
  if (!source) return err([{ code: "unknown_source", message: "Unknown source" }]);
  if (source.projectId !== args.projectId) return err([{ code: "wrong_project", message: "Source belongs to a different project" }]);
  if (source.status !== "present" || !source.currentVersionId) return err([{ code: "source_missing", message: "Source is not present; rescan" }]);
  if (source.currentVersionId !== input.baseVersionId) return err([{ code: "stale_version", message: "baseVersionId is not the current version; re-read the source" }]);
  const version = store.getVersion(input.baseVersionId);
  if (!version) return err([{ code: "unknown_source", message: "Version not found" }]);
  if (containsSecretLike(input.rationale)) return err([{ code: "secret_in_text", message: "Rationale looks like it contains a secret; it was not stored" }]);
  const findingIds: FindingId[] = [];
  for (const id of input.findingIds) {
    const f = isFindingId(id) ? store.getFinding(id) : null;
    if (!f || f.projectId !== args.projectId) return err([{ code: "unknown_finding", message: `Unknown finding ${id}` }]);
    findingIds.push(f.finding.id);
  }
  if (input.edits.some((e) => containsSecretLike(e.replacementLines.join("\n")))) {
    return err([{ code: "secret_in_replacement", message: "Replacement text looks like it contains a secret; proposals may not add secrets" }]);
  }
  const applied = applyLineEdits(version.lines, input.edits, new Set(version.redactedLineNumbers));
  if (!applied.ok) return applied;
  if (applied.value.join("\n") === version.lines.join("\n")) return err([{ code: "no_change", message: "Edits do not change the file" }]);
  if (Buffer.byteLength(applied.value.join("\n"), "utf8") > LIMITS.maxFileBytes) return err([{ code: "too_large", message: "Result would exceed the size limit" }]);

  const base = { projectId: args.projectId, sourceId: source.id, relPath: source.relPath, baseVersionId: version.id, baseRawSha256: version.rawSha256, edits: input.edits };
  const digest = proposalDigest(base);
  const diff = renderDiff(source.relPath, version.lines, input.edits);
  // The same edits against the same base version are the same change; return the pending
  // one instead of creating a second proposal. This says nothing about the change being right.
  const existing = store.findProposalByDigest(args.projectId, digest, "pending");
  if (existing) return ok({ proposal: existing.body, diff, duplicate: true });
  const proposal: ProposalBody = {
    ...base,
    id: newProposalId(),
    rationale: input.rationale,
    findingIds,
    author: args.author,
    proposalSha256: digest,
    createdAt: new Date().toISOString(),
  };
  store.transaction(() => {
    store.insertProposal(proposal);
    store.audit({ actor: args.author, action: "proposal_created", entityId: proposal.id, detail: { sourceId: source.id, baseVersionId: version.id } });
  });
  return ok({ proposal, diff, duplicate: false });
}
