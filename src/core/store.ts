import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SourceFormat } from "./formats.ts";
import {
  newApprovalId,
  newProjectId,
  newSourceId,
  newVersionId,
  type ApprovalId,
  type FindingId,
  type ProjectId,
  type ProposalId,
  type SourceId,
  type VersionId,
} from "./ids.ts";
import {
  ApprovalIdSchema,
  FindingSchema,
  ProjectIdSchema,
  ProposalBodySchema,
  ProposalIdSchema,
  ProposalStatusSchema,
  Sha256Schema,
  SourceFormatSchema,
  SourceIdSchema,
  VersionIdSchema,
  type Finding,
  type ProposalBody,
  type ProposalStatus,
} from "./schemas.ts";

export const DB_FILE = "workspace.sqlite";
const SCHEMA_VERSION = "1";
const now = (): string => new Date().toISOString();

const MIGRATION = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, root_real TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), rel_path TEXT NOT NULL, format TEXT NOT NULL,
  current_version_id TEXT, status TEXT NOT NULL, UNIQUE(project_id, rel_path));
CREATE TABLE IF NOT EXISTS versions(
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), raw_sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL,
  line_count INTEGER NOT NULL, redacted_text TEXT NOT NULL, redacted_lines TEXT NOT NULL, origin TEXT NOT NULL, captured_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exclusions(project_id TEXT NOT NULL REFERENCES projects(id), rel_path TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS findings(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), source_id TEXT NOT NULL REFERENCES sources(id),
  base_version_id TEXT NOT NULL REFERENCES versions(id), proposal_sha256 TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals(
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id), proposal_sha256 TEXT NOT NULL, base_raw_sha256 TEXT NOT NULL,
  decided_by TEXT NOT NULL, decided_at TEXT NOT NULL, state TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE IF NOT EXISTS audit_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL);
`;

export type Project = { id: ProjectId; name: string; rootReal: string; createdAt: string };
export type SourceStatus = "present" | "missing";
export type Source = {
  id: SourceId;
  projectId: ProjectId;
  relPath: string;
  format: SourceFormat;
  currentVersionId: VersionId | null;
  status: SourceStatus;
};
export type VersionOrigin = "import" | "apply";
export type Version = {
  id: VersionId;
  sourceId: SourceId;
  rawSha256: string;
  byteLength: number;
  lineCount: number;
  /** Redacted lines; secret-like values never reach the store. */
  lines: string[];
  redactedLineNumbers: number[];
  origin: VersionOrigin;
  capturedAt: string;
};
export type Exclusion = { relPath: string; reason: string };
export type ApprovalState = "active" | "consumed" | "void";
export type Approval = {
  id: ApprovalId;
  proposalId: ProposalId;
  proposalSha256: string;
  baseRawSha256: string;
  decidedBy: string;
  decidedAt: string;
  state: ApprovalState;
  consumedAt: string | null;
};
export type StoredProposal = { body: ProposalBody; status: ProposalStatus; updatedAt: string };
export type NewVersionInput = {
  rawSha256: string;
  byteLength: number;
  lines: readonly string[];
  redactedLineNumbers: readonly number[];
  origin: VersionOrigin;
};

const ProjectRow = z.object({ id: ProjectIdSchema, name: z.string(), root_real: z.string(), created_at: z.string() });
const SourceRow = z.object({
  id: SourceIdSchema,
  project_id: ProjectIdSchema,
  rel_path: z.string(),
  format: SourceFormatSchema,
  current_version_id: VersionIdSchema.nullable(),
  status: z.enum(["present", "missing"]),
});
const VersionRow = z.object({
  id: VersionIdSchema,
  source_id: SourceIdSchema,
  raw_sha256: Sha256Schema,
  byte_length: z.number().int(),
  line_count: z.number().int(),
  redacted_text: z.string(),
  redacted_lines: z.string(),
  origin: z.enum(["import", "apply"]),
  captured_at: z.string(),
});
const LineNumbers = z.array(z.number().int().min(1));
const ExclusionRow = z.object({ rel_path: z.string(), reason: z.string() });
const BodyRow = z.object({ body: z.string() });
const ProposalRow = z.object({ body: z.string(), status: ProposalStatusSchema, updated_at: z.string() });
const ApprovalRow = z.object({
  id: ApprovalIdSchema,
  proposal_id: ProposalIdSchema,
  proposal_sha256: Sha256Schema,
  base_raw_sha256: Sha256Schema,
  decided_by: z.string(),
  decided_at: z.string(),
  state: z.enum(["active", "consumed", "void"]),
  consumed_at: z.string().nullable(),
});
const AuditRow = z.object({ seq: z.number().int(), at: z.string(), actor: z.string(), action: z.string(), entity_id: z.string(), detail: z.string() });
export type AuditEvent = z.infer<typeof AuditRow>;

const toProject = (r: z.infer<typeof ProjectRow>): Project => ({ id: r.id, name: r.name, rootReal: r.root_real, createdAt: r.created_at });
const toSource = (r: z.infer<typeof SourceRow>): Source => ({
  id: r.id,
  projectId: r.project_id,
  relPath: r.rel_path,
  format: r.format,
  currentVersionId: r.current_version_id,
  status: r.status,
});
const toVersion = (r: z.infer<typeof VersionRow>): Version => ({
  id: r.id,
  sourceId: r.source_id,
  rawSha256: r.raw_sha256,
  byteLength: r.byte_length,
  lineCount: r.line_count,
  lines: r.redacted_text.split("\n"),
  redactedLineNumbers: LineNumbers.parse(JSON.parse(r.redacted_lines)),
  origin: r.origin,
  capturedAt: r.captured_at,
});
const toApproval = (r: z.infer<typeof ApprovalRow>): Approval => ({
  id: r.id,
  proposalId: r.proposal_id,
  proposalSha256: r.proposal_sha256,
  baseRawSha256: r.base_raw_sha256,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  state: r.state,
  consumedAt: r.consumed_at,
});

/**
 * Local workspace persistence (one SQLite file in a directory the human chooses).
 * Stores metadata, redacted text, findings, proposals, approvals and an audit log.
 * It never stores raw secret-like values and never stores project files outside redaction.
 */
export class WorkspaceStore {
  readonly dir: string;
  readonly backupDir: string;
  private readonly db: DatabaseSync;

  private constructor(dir: string, db: DatabaseSync) {
    this.dir = dir;
    this.backupDir = path.join(dir, "backups");
    this.db = db;
  }

  static open(dir: string): WorkspaceStore {
    const absDir = path.resolve(dir);
    mkdirSync(absDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(absDir, DB_FILE));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db.exec(MIGRATION);
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    return new WorkspaceStore(absDir, db);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  audit(args: { actor: string; action: string; entityId: string; detail?: unknown }): void {
    this.db
      .prepare("INSERT INTO audit_events(at, actor, action, entity_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(now(), args.actor, args.action, args.entityId, JSON.stringify(args.detail ?? {}));
  }

  listAudit(entityId?: string): AuditEvent[] {
    const rows = entityId
      ? this.db.prepare("SELECT * FROM audit_events WHERE entity_id = ? ORDER BY seq").all(entityId)
      : this.db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
    return rows.map((r) => AuditRow.parse(r));
  }

  // Projects ---------------------------------------------------------------
  addProject(args: { name: string; rootReal: string }): Project {
    const project: Project = { id: newProjectId(), name: args.name, rootReal: args.rootReal, createdAt: now() };
    this.db
      .prepare("INSERT INTO projects(id, name, root_real, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.rootReal, project.createdAt);
    return project;
  }

  getProject(id: ProjectId): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? toProject(ProjectRow.parse(row)) : null;
  }

  findProjectByRoot(rootReal: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE root_real = ?").get(rootReal);
    return row ? toProject(ProjectRow.parse(row)) : null;
  }

  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at").all().map((r) => toProject(ProjectRow.parse(r)));
  }

  // Sources and versions ---------------------------------------------------
  getSource(id: SourceId): Source | null {
    const row = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    return row ? toSource(SourceRow.parse(row)) : null;
  }

  listSources(projectId: ProjectId): Source[] {
    return this.db
      .prepare("SELECT * FROM sources WHERE project_id = ? ORDER BY rel_path")
      .all(projectId)
      .map((r) => toSource(SourceRow.parse(r)));
  }

  getVersion(id: VersionId): Version | null {
    const row = this.db.prepare("SELECT * FROM versions WHERE id = ?").get(id);
    return row ? toVersion(VersionRow.parse(row)) : null;
  }

  /** Records a new version only when the raw bytes changed. Caller owns the transaction. */
  recordVersion(args: { projectId: ProjectId; relPath: string; format: SourceFormat; version: NewVersionInput }): {
    source: Source;
    version: Version;
    changed: boolean;
  } {
    const existingRow = this.db.prepare("SELECT * FROM sources WHERE project_id = ? AND rel_path = ?").get(args.projectId, args.relPath);
    let source = existingRow ? toSource(SourceRow.parse(existingRow)) : null;
    if (source?.currentVersionId) {
      const current = this.getVersion(source.currentVersionId);
      if (current && current.rawSha256 === args.version.rawSha256) {
        if (source.status !== "present") {
          this.db.prepare("UPDATE sources SET status = 'present' WHERE id = ?").run(source.id);
          source = { ...source, status: "present" };
        }
        return { source, version: current, changed: false };
      }
    }
    if (!source) {
      source = { id: newSourceId(), projectId: args.projectId, relPath: args.relPath, format: args.format, currentVersionId: null, status: "present" };
      this.db
        .prepare("INSERT INTO sources(id, project_id, rel_path, format, current_version_id, status) VALUES (?, ?, ?, ?, NULL, 'present')")
        .run(source.id, source.projectId, source.relPath, source.format);
    }
    const version: Version = {
      id: newVersionId(),
      sourceId: source.id,
      rawSha256: args.version.rawSha256,
      byteLength: args.version.byteLength,
      lineCount: args.version.lines.length,
      lines: [...args.version.lines],
      redactedLineNumbers: [...args.version.redactedLineNumbers],
      origin: args.version.origin,
      capturedAt: now(),
    };
    this.db
      .prepare(
        "INSERT INTO versions(id, source_id, raw_sha256, byte_length, line_count, redacted_text, redacted_lines, origin, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        version.id,
        version.sourceId,
        version.rawSha256,
        version.byteLength,
        version.lineCount,
        version.lines.join("\n"),
        JSON.stringify(version.redactedLineNumbers),
        version.origin,
        version.capturedAt,
      );
    this.db.prepare("UPDATE sources SET current_version_id = ?, status = 'present' WHERE id = ?").run(version.id, source.id);
    return { source: { ...source, currentVersionId: version.id, status: "present" }, version, changed: true };
  }

  markMissingExcept(projectId: ProjectId, presentRelPaths: ReadonlySet<string>): number {
    let missing = 0;
    for (const s of this.listSources(projectId)) {
      if (!presentRelPaths.has(s.relPath) && s.status !== "missing") {
        this.db.prepare("UPDATE sources SET status = 'missing' WHERE id = ?").run(s.id);
        missing += 1;
      }
    }
    return missing;
  }

  replaceExclusions(projectId: ProjectId, exclusions: readonly Exclusion[]): void {
    this.db.prepare("DELETE FROM exclusions WHERE project_id = ?").run(projectId);
    const insert = this.db.prepare("INSERT INTO exclusions(project_id, rel_path, reason) VALUES (?, ?, ?)");
    for (const e of exclusions) insert.run(projectId, e.relPath, e.reason);
  }

  listExclusions(projectId: ProjectId): Exclusion[] {
    return this.db
      .prepare("SELECT rel_path, reason FROM exclusions WHERE project_id = ? ORDER BY rel_path")
      .all(projectId)
      .map((r) => {
        const row = ExclusionRow.parse(r);
        return { relPath: row.rel_path, reason: row.reason };
      });
  }

  // Findings ---------------------------------------------------------------
  replaceStructuralFindings(projectId: ProjectId, findings: readonly Finding[]): void {
    this.db.prepare("DELETE FROM findings WHERE project_id = ? AND kind = 'structural'").run(projectId);
    const insert = this.db.prepare("INSERT INTO findings(id, project_id, kind, body, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)");
    for (const f of findings) insert.run(f.id, projectId, f.kind, JSON.stringify(f), now());
  }

  insertFinding(projectId: ProjectId, finding: Finding): void {
    this.db
      .prepare("INSERT INTO findings(id, project_id, kind, body, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
      .run(finding.id, projectId, finding.kind, JSON.stringify(finding), now());
  }

  getFinding(id: FindingId): { projectId: ProjectId; finding: Finding } | null {
    const row = this.db.prepare("SELECT project_id, body FROM findings WHERE id = ?").get(id);
    if (!row) return null;
    const parsed = z.object({ project_id: ProjectIdSchema, body: z.string() }).parse(row);
    return { projectId: parsed.project_id, finding: FindingSchema.parse(JSON.parse(parsed.body)) };
  }

  listFindings(projectId: ProjectId, kind?: Finding["kind"]): Finding[] {
    const rows = kind
      ? this.db.prepare("SELECT body FROM findings WHERE project_id = ? AND kind = ? ORDER BY kind, created_at, id").all(projectId, kind)
      : this.db.prepare("SELECT body FROM findings WHERE project_id = ? ORDER BY kind, created_at, id").all(projectId);
    return rows.map((r) => FindingSchema.parse(JSON.parse(BodyRow.parse(r).body)));
  }

  // Proposals --------------------------------------------------------------
  insertProposal(body: ProposalBody): void {
    this.db
      .prepare(
        "INSERT INTO proposals(id, project_id, source_id, base_version_id, proposal_sha256, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(body.id, body.projectId, body.sourceId, body.baseVersionId, body.proposalSha256, JSON.stringify(body), body.createdAt, body.createdAt);
  }

  getProposal(id: ProposalId): StoredProposal | null {
    const row = this.db.prepare("SELECT body, status, updated_at FROM proposals WHERE id = ?").get(id);
    if (!row) return null;
    const parsed = ProposalRow.parse(row);
    return { body: ProposalBodySchema.parse(JSON.parse(parsed.body)), status: parsed.status, updatedAt: parsed.updated_at };
  }

  listProposals(projectId: ProjectId): StoredProposal[] {
    return this.db
      .prepare("SELECT body, status, updated_at FROM proposals WHERE project_id = ? ORDER BY created_at")
      .all(projectId)
      .map((r) => {
        const parsed = ProposalRow.parse(r);
        return { body: ProposalBodySchema.parse(JSON.parse(parsed.body)), status: parsed.status, updatedAt: parsed.updated_at };
      });
  }

  /** Compare-and-set on proposal status; returns false when the current status differs. */
  transitionProposal(id: ProposalId, from: ProposalStatus, to: ProposalStatus): boolean {
    const r = this.db.prepare("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(to, now(), id, from);
    return Number(r.changes) === 1;
  }

  // Approvals --------------------------------------------------------------
  insertApproval(args: { proposalId: ProposalId; proposalSha256: string; baseRawSha256: string; decidedBy: string }): Approval {
    const approval: Approval = {
      id: newApprovalId(),
      proposalId: args.proposalId,
      proposalSha256: args.proposalSha256,
      baseRawSha256: args.baseRawSha256,
      decidedBy: args.decidedBy,
      decidedAt: now(),
      state: "active",
      consumedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO approvals(id, proposal_id, proposal_sha256, base_raw_sha256, decided_by, decided_at, state, consumed_at) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL)",
      )
      .run(approval.id, approval.proposalId, approval.proposalSha256, approval.baseRawSha256, approval.decidedBy, approval.decidedAt);
    return approval;
  }

  getActiveApproval(proposalId: ProposalId): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE proposal_id = ? AND state = 'active'").get(proposalId);
    return row ? toApproval(ApprovalRow.parse(row)) : null;
  }

  listApprovals(proposalId: ProposalId): Approval[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE proposal_id = ? ORDER BY decided_at")
      .all(proposalId)
      .map((r) => toApproval(ApprovalRow.parse(r)));
  }

  /** Single-use: only an active approval can be consumed, exactly once. */
  consumeApproval(id: ApprovalId): boolean {
    const r = this.db.prepare("UPDATE approvals SET state = 'consumed', consumed_at = ? WHERE id = ? AND state = 'active'").run(now(), id);
    return Number(r.changes) === 1;
  }

  voidActiveApprovals(proposalId: ProposalId): void {
    this.db.prepare("UPDATE approvals SET state = 'void' WHERE proposal_id = ? AND state = 'active'").run(proposalId);
  }
}
