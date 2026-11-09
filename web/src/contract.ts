/** API response types, imported (type-only) from the core so the site and service cannot drift. */
export type { ProjectStatus, WorkspaceStatus } from "../../src/core/service/status.ts";
export type { FreshnessReport, ProposalSummary, SourceRead, SourceSummary } from "../../src/core/service/assistant.ts";
export type { Finding } from "../../src/core/schemas.ts";
export type { ScopeResolution } from "../../src/core/scope.ts";
export type { SourceFreshnessState } from "../../src/core/freshness.ts";

export type SourcesResponse = { sources: import("../../src/core/service/assistant.ts").SourceSummary[]; notRead: { relPath: string; reason: string }[]; note: string };
export type FindingsResponse = { findings: import("../../src/core/schemas.ts").Finding[]; staleHidden: number };
export type ProposalsResponse = { proposals: import("../../src/core/service/assistant.ts").ProposalSummary[]; note: string };
