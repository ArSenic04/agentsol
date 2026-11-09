import { z } from "zod";
import { validateQuotedSpan, type EvidenceError } from "./evidence.ts";
import { newFindingId, type FindingId, type ProjectId } from "./ids.ts";
import { SEMANTIC_CHECK_IDS, type EvidenceSpan, type SemanticFinding } from "./schemas.ts";
import { containsSecretLike } from "./secrets.ts";
import type { WorkspaceStore } from "./store.ts";

export const SEMANTIC_CHECKS: Record<(typeof SEMANTIC_CHECK_IDS)[number], { title: string; minDistinctSources: number }> = {
  S01: { title: "Instructions may contradict each other", minDistinctSources: 2 },
  S02: { title: "Instruction may be stale or reference something that no longer exists", minDistinctSources: 1 },
  S03: { title: "Instruction may be vague or hard to verify", minDistinctSources: 1 },
  S04: { title: "Content may belong in a different scope", minDistinctSources: 1 },
  S05: { title: "Skill description may not match the skill body", minDistinctSources: 1 },
};

export const QuotedSpanInputSchema = z.object({
  sourceId: z.string().describe("Source id from sources_list"),
  versionId: z.string().describe("The source's current versionId from source_read"),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  quote: z.string().max(20_000).describe("Exact text of lines startLine..endLine as returned by source_read (joined with \\n)"),
});

export const SemanticFindingInputSchema = z.object({
  checkId: z.enum(SEMANTIC_CHECK_IDS),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000).describe("Describe a possibility, not a proven fact"),
  severity: z.enum(["info", "warn"]),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(QuotedSpanInputSchema).min(1).max(10),
  suggestedFix: z.string().max(4_000).optional(),
});
export type SemanticFindingInput = z.infer<typeof SemanticFindingInputSchema>;

export type SubmitResult = {
  accepted: FindingId[];
  /** Subset of accepted: identical to a finding already recorded, so the existing id is returned. */
  duplicates: FindingId[];
  rejected: { index: number; errors: (EvidenceError | { code: "too_few_sources" | "secret_in_text"; message: string })[] }[];
};

/** Stores assistant-reported findings that carry valid, current, exact evidence. */
export function submitSemanticFindings(
  store: WorkspaceStore,
  args: { projectId: ProjectId; findings: readonly SemanticFindingInput[]; reporter: string },
): SubmitResult {
  const result: SubmitResult = { accepted: [], duplicates: [], rejected: [] };
  const contentKey = (f: { checkId: string; title: string; message: string; evidence: readonly EvidenceSpan[] }): string =>
    JSON.stringify([f.checkId, f.title, f.message, f.evidence.map((e) => [e.sourceId, e.versionId, e.startLine, e.endLine])]);
  const known = new Map<string, FindingId>();
  for (const f of store.listFindings(args.projectId, "semantic")) known.set(contentKey(f), f.id);
  args.findings.forEach((input, index) => {
    const spans: EvidenceSpan[] = [];
    const errors: SubmitResult["rejected"][number]["errors"] = [];
    for (const q of input.evidence) {
      const v = validateQuotedSpan(store, args.projectId, q);
      if (v.ok) spans.push(v.value);
      else errors.push(v.error);
    }
    if ([input.title, input.message, input.suggestedFix ?? ""].some((t) => containsSecretLike(t))) {
      errors.push({ code: "secret_in_text", message: "Finding text looks like it contains a secret; it was not stored" });
    }
    const distinct = new Set(spans.map((s) => s.sourceId)).size;
    const min = SEMANTIC_CHECKS[input.checkId].minDistinctSources;
    if (errors.length === 0 && distinct < min) {
      errors.push({ code: "too_few_sources", message: `${input.checkId} needs evidence from at least ${min} different source files` });
    }
    if (errors.length > 0) {
      result.rejected.push({ index, errors });
      return;
    }
    const key = contentKey({ checkId: input.checkId, title: input.title, message: input.message, evidence: spans });
    const dup = known.get(key);
    if (dup) {
      result.accepted.push(dup);
      result.duplicates.push(dup);
      return;
    }
    const finding: SemanticFinding = {
      kind: "semantic",
      id: newFindingId(),
      checkId: input.checkId,
      claim: "possible",
      severity: input.severity,
      confidence: input.confidence,
      title: input.title,
      message: input.message,
      evidence: spans,
      reporter: args.reporter,
      suggestedFix: input.suggestedFix ?? null,
    };
    store.transaction(() => {
      store.insertFinding(args.projectId, finding);
      store.audit({ actor: args.reporter, action: "finding_submitted", entityId: finding.id, detail: { checkId: finding.checkId } });
    });
    known.set(key, finding.id);
    result.accepted.push(finding.id);
  });
  return result;
}
