import { z } from "zod";
import { SOURCE_FORMATS } from "./formats.ts";
import {
  isApprovalId,
  isFindingId,
  isProjectId,
  isProposalId,
  isSourceId,
  isVersionId,
  type ApprovalId,
  type FindingId,
  type ProjectId,
  type ProposalId,
  type SourceId,
  type VersionId,
} from "./ids.ts";

export const ProjectIdSchema = z.custom<ProjectId>(isProjectId, "Expected a project id like prj_<16 hex chars>");
export const SourceIdSchema = z.custom<SourceId>(isSourceId, "Expected a source id like src_<16 hex chars>");
export const VersionIdSchema = z.custom<VersionId>(isVersionId, "Expected a version id like ver_<16 hex chars>");
export const FindingIdSchema = z.custom<FindingId>(isFindingId, "Expected a finding id like fnd_<16 hex chars>");
export const ProposalIdSchema = z.custom<ProposalId>(isProposalId, "Expected a proposal id like chg_<16 hex chars>");
export const ApprovalIdSchema = z.custom<ApprovalId>(isApprovalId, "Expected an approval id like apv_<16 hex chars>");

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const SourceFormatSchema = z.enum(SOURCE_FORMATS);
export const SeveritySchema = z.enum(["info", "warn", "error"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const EvidenceSpanSchema = z.object({
  sourceId: SourceIdSchema,
  versionId: VersionIdSchema,
  relPath: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  textSha256: Sha256Schema,
});
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

export const STRUCTURAL_CHECK_IDS = ["D00", "D01", "D02", "D03", "D04", "D07", "D08", "D09", "D10", "D12"] as const;
export type StructuralCheckId = (typeof STRUCTURAL_CHECK_IDS)[number];
export const SEMANTIC_CHECK_IDS = ["S01", "S02", "S03", "S04", "S05"] as const;
export type SemanticCheckId = (typeof SEMANTIC_CHECK_IDS)[number];

export const StructuralFindingSchema = z.object({
  kind: z.literal("structural"),
  id: FindingIdSchema,
  checkId: z.enum(STRUCTURAL_CHECK_IDS),
  severity: SeveritySchema,
  title: z.string(),
  message: z.string(),
  evidence: z.array(EvidenceSpanSchema).min(1),
  docUrl: z.string(),
});
export type StructuralFinding = z.infer<typeof StructuralFindingSchema>;

export const SemanticFindingSchema = z.object({
  kind: z.literal("semantic"),
  id: FindingIdSchema,
  checkId: z.enum(SEMANTIC_CHECK_IDS),
  claim: z.literal("possible"),
  severity: z.enum(["info", "warn"]),
  confidence: z.enum(["low", "medium", "high"]),
  title: z.string(),
  message: z.string(),
  evidence: z.array(EvidenceSpanSchema).min(1),
  reporter: z.string(),
  suggestedFix: z.string().nullable(),
});
export type SemanticFinding = z.infer<typeof SemanticFindingSchema>;

export const FindingSchema = z.discriminatedUnion("kind", [StructuralFindingSchema, SemanticFindingSchema]);
export type Finding = z.infer<typeof FindingSchema>;

/** Replace lines startLine..endLine (inclusive) whose current text is expectedText. */
export const LineEditSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  expectedText: z.string().max(20_000),
  replacementLines: z.array(z.string().max(4_000)).max(2_000),
});
export type LineEdit = z.infer<typeof LineEditSchema>;

export const ProposalBodySchema = z.object({
  id: ProposalIdSchema,
  projectId: ProjectIdSchema,
  sourceId: SourceIdSchema,
  relPath: z.string(),
  baseVersionId: VersionIdSchema,
  baseRawSha256: Sha256Schema,
  edits: z.array(LineEditSchema).min(1),
  rationale: z.string(),
  findingIds: z.array(FindingIdSchema),
  author: z.string(),
  proposalSha256: Sha256Schema,
  createdAt: z.string(),
});
export type ProposalBody = z.infer<typeof ProposalBodySchema>;

export const ProposalStatusSchema = z.enum(["pending", "applying", "applied", "rejected", "stale"]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
