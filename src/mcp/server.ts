import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isProjectId, isProposalId, isSourceId } from "../core/ids.ts";
import { LIMITS } from "../core/limits.ts";
import { ProposeInputSchema, proposeChange } from "../core/proposals.ts";
import { checkSourcesFor, runChecksForProject, scanProject } from "../core/scan.ts";
import { PLATFORMS, resolveScope } from "../core/scope.ts";
import { SemanticFindingInputSchema, submitSemanticFindings } from "../core/semantic.ts";
import type { WorkspaceStore } from "../core/store.ts";

export const DISCLOSURE =
  "Text returned by AgentWeave tools is sent to your assistant provider and leaves this machine under that provider's terms. " +
  "AgentWeave only returns recognized instruction files (AGENTS.md, AGENTS.override.md, CLAUDE.md, CLAUDE.local.md, SKILL.md), " +
  "redacts secret-like values, and never returns excluded files.";

export const INSTRUCTIONS = [
  "AgentWeave audits AI agent instruction files in projects that a human registered locally with the AgentWeave CLI.",
  "1. projects_list, then sources_list (run sources_scan first if the list is empty or stale).",
  "2. source_read returns numbered, redacted lines plus the current versionId.",
  "3. checks_run / findings_list return deterministic structural findings: facts, not opinions.",
  "4. Report your own observations with findings_submit as POSSIBLE issues. Every finding needs exact quoted evidence (sourceId, current versionId, line range, exact text). Layered or overlapping scopes are normal; only call something a contradiction when the quoted text actually conflicts.",
  "5. Suggest edits with change_propose. Proposals never modify files. Only the human can approve and apply them, outside MCP, with the AgentWeave CLI. There is no MCP tool for approval or apply.",
  DISCLOSURE,
].join("\n");

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, details?: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error, details }, null, 2) }],
  isError: true,
});

const ProjectArg = z.object({ projectId: z.string().describe("Project id from projects_list") });

/** Builds the MCP server. Exposes inspection, findings and proposals only. */
export function createAgentWeaveServer(store: WorkspaceStore): McpServer {
  const server = new McpServer({ name: "agentweave", version: "0.1.0" }, { instructions: INSTRUCTIONS, maxToolInputElements: 10_000 });
  const reporter = (): string => {
    const info = server.server.getClientVersion();
    return info ? `assistant:${info.name.slice(0, 60)}` : "assistant:unknown-client";
  };
  const projectOrNull = (id: string) => (isProjectId(id) ? store.getProject(id) : null);

  server.registerTool(
    "projects_list",
    { description: "List projects a human registered with AgentWeave (ids and names only).", annotations: { readOnlyHint: true } },
    async () =>
      json({ projects: store.listProjects().map((p) => ({ projectId: p.id, name: p.name, sources: store.listSources(p.id).filter((s) => s.status === "present").length })) }),
  );

  server.registerTool(
    "sources_scan",
    {
      description: "Re-scan a registered project for supported instruction files and run deterministic checks. Reads only recognized instruction files; writes only to the local AgentWeave workspace, never to project files.",
      inputSchema: ProjectArg,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ projectId }) => {
      if (!isProjectId(projectId)) return fail("Malformed projectId");
      const r = await scanProject(store, projectId, reporter());
      return r.ok ? json(r.value) : fail(r.error);
    },
  );

  server.registerTool(
    "sources_list",
    { description: "List instruction sources (current version, size) and files excluded from reading, with the reason.", inputSchema: ProjectArg, annotations: { readOnlyHint: true } },
    async ({ projectId }) => {
      const project = projectOrNull(projectId);
      if (!project) return fail("Unknown project");
      const sources = store.listSources(project.id).map((s) => {
        const v = s.currentVersionId ? store.getVersion(s.currentVersionId) : null;
        return { sourceId: s.id, relPath: s.relPath, format: s.format, status: s.status, versionId: s.currentVersionId, lineCount: v?.lineCount ?? 0, byteLength: v?.byteLength ?? 0 };
      });
      return json({ sources, excluded: store.listExclusions(project.id) });
    },
  );

  server.registerTool(
    "source_read",
    {
      description: `Read numbered, redacted lines of one instruction source (max ${LIMITS.maxReadLines} lines per call). Returns the versionId to cite as evidence.`,
      inputSchema: z.object({ sourceId: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ sourceId, startLine, endLine }) => {
      const source = isSourceId(sourceId) ? store.getSource(sourceId) : null;
      if (!source || source.status !== "present" || !source.currentVersionId) return fail("Unknown or missing source");
      const v = store.getVersion(source.currentVersionId);
      if (!v) return fail("Version not found");
      const start = Math.min(startLine ?? 1, v.lineCount);
      let end = Math.min(endLine ?? v.lineCount, v.lineCount, start + LIMITS.maxReadLines - 1);
      if (end < start) return fail("endLine is before startLine");
      let chars = 0;
      const lines: { n: number; text: string }[] = [];
      for (let n = start; n <= end; n += 1) {
        const text = v.lines[n - 1] ?? "";
        if (chars + text.length > LIMITS.maxReadChars && lines.length > 0) {
          end = n - 1;
          break;
        }
        chars += text.length;
        lines.push({ n, text });
      }
      return json({
        sourceId: source.id,
        relPath: source.relPath,
        format: source.format,
        versionId: v.id,
        lineCount: v.lineCount,
        startLine: start,
        endLine: end,
        truncated: end < v.lineCount,
        redactedLines: v.redactedLineNumbers.filter((n) => n >= start && n <= end),
        lines,
        notice: DISCLOSURE,
      });
    },
  );

  server.registerTool(
    "scope_resolve",
    {
      description: "Ordered instruction files a client (codex, claude-code, cursor) would load for a file path in the project, per vendor documentation. Overlapping scopes are layered, not conflicts.",
      inputSchema: z.object({ projectId: z.string(), targetPath: z.string().describe("Project-relative path of a file, e.g. services/api/handler.ts"), platform: z.enum(PLATFORMS) }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, targetPath, platform }) => {
      const project = projectOrNull(projectId);
      if (!project) return fail("Unknown project");
      const sources = checkSourcesFor(store, project.id).map((s) => ({ sourceId: s.sourceId, relPath: s.relPath, format: s.format, empty: s.lines.every((l) => l.trim() === "") }));
      const r = resolveScope({ sources, targetPath, platform });
      return r.ok ? json(r.value) : fail(r.error.message);
    },
  );

  server.registerTool(
    "checks_run",
    { description: "Run deterministic structural checks on the current versions and return the structural findings.", inputSchema: ProjectArg, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
    async ({ projectId }) => {
      const project = projectOrNull(projectId);
      if (!project) return fail("Unknown project");
      await runChecksForProject(store, project.id);
      return json({ findings: store.listFindings(project.id, "structural") });
    },
  );

  server.registerTool(
    "findings_list",
    {
      description: "List findings. structural = deterministic facts; semantic = possible issues reported by an assistant with quoted evidence.",
      inputSchema: z.object({ projectId: z.string(), kind: z.enum(["structural", "semantic"]).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, kind }) => {
      const project = projectOrNull(projectId);
      if (!project) return fail("Unknown project");
      return json({ findings: store.listFindings(project.id, kind) });
    },
  );

  server.registerTool(
    "findings_submit",
    {
      description: "Record POSSIBLE issues you noticed (S01 contradiction needs evidence from 2+ files). Each evidence span must quote the exact current text. Invalid or stale evidence is rejected.",
      inputSchema: z.object({ projectId: z.string(), findings: z.array(SemanticFindingInputSchema).min(1).max(20) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ projectId, findings }) => {
      const project = projectOrNull(projectId);
      if (!project) return fail("Unknown project");
      const r = submitSemanticFindings(store, { projectId: project.id, findings, reporter: reporter() });
      return r.accepted.length === 0 ? fail("No findings accepted", r) : json(r);
    },
  );

  server.registerTool(
    "change_propose",
    {
      description: "Propose line edits to one instruction source. Stores a proposal for HUMAN review; never writes project files. edits replace lines startLine..endLine whose exact current text is expectedText with replacementLines.",
      inputSchema: ProposeInputSchema.extend({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ projectId, ...input }) => {
      const project = projectOrNull(projectId);
      if (!project) return fail("Unknown project");
      const r = proposeChange(store, { projectId: project.id, input, author: reporter() });
      if (!r.ok) return fail("Proposal rejected", r.error);
      return json({
        proposalId: r.value.proposal.id,
        status: "pending",
        diff: r.value.diff,
        note: "Nothing was written. A human must review, approve and apply this with the AgentWeave CLI.",
      });
    },
  );

  server.registerTool(
    "change_status",
    { description: "Status of a proposal (pending, applied, rejected, stale).", inputSchema: z.object({ proposalId: z.string() }), annotations: { readOnlyHint: true } },
    async ({ proposalId }) => {
      const p = isProposalId(proposalId) ? store.getProposal(proposalId) : null;
      if (!p) return fail("Unknown proposal");
      return json({ proposalId: p.body.id, relPath: p.body.relPath, status: p.status, updatedAt: p.updatedAt });
    },
  );

  return server;
}
