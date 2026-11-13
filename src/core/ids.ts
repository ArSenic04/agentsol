import { randomBytes } from "node:crypto";

// Ids are prefixed random hex. Template-literal types keep them from being mixed up
// without `as` casts; `isX` guards verify the full shape at boundaries.
export type ProjectId = `prj_${string}`;
export type SourceId = `src_${string}`;
export type VersionId = `ver_${string}`;
export type FindingId = `fnd_${string}`;
export type ProposalId = `chg_${string}`;
export type ApprovalId = `apv_${string}`;
export type GradeId = `grd_${string}`;

const BODY = /^[0-9a-f]{16}$/;
const body = (): string => randomBytes(8).toString("hex");

export const newProjectId = (): ProjectId => `prj_${body()}`;
export const newSourceId = (): SourceId => `src_${body()}`;
export const newVersionId = (): VersionId => `ver_${body()}`;
export const newFindingId = (): FindingId => `fnd_${body()}`;
export const newProposalId = (): ProposalId => `chg_${body()}`;
export const newApprovalId = (): ApprovalId => `apv_${body()}`;
export const newGradeId = (): GradeId => `grd_${body()}`;

/** Deterministic finding id from 16 hex chars of a digest. */
export const findingIdFromDigest = (hex: string): FindingId => `fnd_${hex.slice(0, 16)}`;

const has = (prefix: string, v: unknown): boolean =>
  typeof v === "string" && v.startsWith(prefix) && BODY.test(v.slice(prefix.length));

export const isProjectId = (v: unknown): v is ProjectId => has("prj_", v);
export const isSourceId = (v: unknown): v is SourceId => has("src_", v);
export const isVersionId = (v: unknown): v is VersionId => has("ver_", v);
export const isFindingId = (v: unknown): v is FindingId => has("fnd_", v);
export const isProposalId = (v: unknown): v is ProposalId => has("chg_", v);
export const isApprovalId = (v: unknown): v is ApprovalId => has("apv_", v);
export const isGradeId = (v: unknown): v is GradeId => has("grd_", v);
