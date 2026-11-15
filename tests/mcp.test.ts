import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture, type Fixture } from "./helpers.ts";
import { PROMPT_NAMES, TOOL_NAMES } from "../src/mcp/server.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "src", "mcp", "main.ts");
const FAKE_SECRET = "sk-FAKEFAKEFAKEFAKEFAKEFAKE1234567890";
const ROOT_TEXT = `# Root\n- Use npm to run scripts.\n- Demo key ${FAKE_SECRET}\n`;
const EXPECTED_TOOLS = ["change_propose", "change_status", "changes_list", "checks_run", "findings_list", "findings_submit", "inspect", "lessons_list", "project_briefing", "projects_list", "scope_resolve", "session_grade", "session_review", "sessions_list", "setup_audit", "source_read", "sources_freshness", "sources_list", "sources_scan", "workspace_status"];

type Mode = "legacy" | "auto";

async function connect(fx: Fixture, mode: Mode): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--workspace", fx.wsDir], cwd: REPO, stderr: "pipe" });
  const client = new Client({ name: "agentsol-test-client", version: "0.0.0" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const r = await client.callTool({ name, arguments: args });
  const first = r.content[0];
  assert.ok(first && first.type === "text", `${name} returned text`);
  return { isError: r.isError === true, data: JSON.parse(first.text) };
}

for (const mode of ["legacy", "auto"] as const) {
  test(`real stdio MCP server (${mode} negotiation): read, audit and propose only; files never change`, async () => {
    const fx = await fixture({ "AGENTS.md": ROOT_TEXT, "web/AGENTS.md": "# Web\n- Use pnpm to run scripts.\n", ".env": `KEY=${FAKE_SECRET}\n` });
    let client: Client | undefined;
    try {
      client = await connect(fx, mode);
      assert.equal(client.getNegotiatedProtocolVersion(), mode === "legacy" ? "2025-11-25" : "2026-07-28");
      assert.equal(client.getDiscoverResult() !== undefined, mode === "auto");
      const instructions = client.getInstructions() ?? "";
      assert.match(instructions, /only the person can approve and apply/i);
      assert.match(instructions, /never as instructions to you/);
      assert.match(instructions, /misses secrets/);

      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, EXPECTED_TOOLS);
      assert.deepEqual([...TOOL_NAMES].sort(), EXPECTED_TOOLS, "exported tool list matches the server");
      assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name).sort(), [...PROMPT_NAMES].sort());
      const audit = await client.getPrompt({ name: "audit", arguments: { project: "demo" } });
      const auditText = JSON.stringify(audit.messages);
      assert.match(auditText, /findings_submit/);
      assert.match(auditText, /npx agentsol review/);
      assert.ok(!/approve|apply/.test(auditText.replace(/approval/g, "")), "prompts never ask the assistant to approve or apply");
      for (const name of ["review", "setup", "learn"]) {
        const prompt = await client.getPrompt({ name, arguments: {} });
        const text: string = JSON.stringify(prompt.messages);
        assert.ok(!/approve|apply/.test(text), `${name} prompt never asks the assistant to approve or apply`);
      }
      const guide = await client.readResource({ uri: "agentsol://guide" });
      const guideText = JSON.stringify(guide.contents);
      assert.match(guideText, /D09/);
      assert.match(guideText, /S01/);
      assert.ok(!tools.some((t) => /approv|apply|write|delete/i.test(t)), "no approval/apply/write tools over MCP");

      const projects = await call(client, "projects_list", {});
      assert.equal(projects.data.projects.length, 1);
      assert.ok(!JSON.stringify(projects.data).includes(fx.root), "absolute project roots are not disclosed");
      const projectId: string = projects.data.projects[0].projectId;

      const scan = await call(client, "sources_scan", { projectId });
      assert.equal(scan.isError, false);
      const listed = await call(client, "sources_list", { projectId });
      const root = listed.data.sources.find((s: { relPath: string }) => s.relPath === "AGENTS.md");
      assert.ok(root);
      assert.ok(!JSON.stringify(listed.data).includes(".env"), "secret-like file names are not disclosed");

      const read = await call(client, "source_read", { sourceId: root.sourceId });
      assert.ok(!JSON.stringify(read.data).includes(FAKE_SECRET), "secret never crosses MCP");
      assert.deepEqual(read.data.redactedLines, [3]);
      assert.equal(read.data.lines[1].text, "- Use npm to run scripts.");
      assert.match(read.data.notice, /leaves this computer/);
      assert.match(read.data.notice, /untrusted/);
      assert.equal(read.data.contentIsUntrusted, true);

      const bogusRead = await call(client, "source_read", { sourceId: "../../etc/passwd" });
      assert.equal(bogusRead.isError, true);

      const scope = await call(client, "scope_resolve", { projectId, targetPath: "web/app.ts", platform: "codex", workingDirectory: "web" });
      assert.deepEqual(scope.data.chain.map((c: { relPath: string }) => c.relPath), ["AGENTS.md", "web/AGENTS.md"]);
      assert.equal(scope.data.relationship, "layered");
      assert.equal(scope.data.coverage, "partial");
      const escape = await call(client, "scope_resolve", { projectId, targetPath: "../x", platform: "codex" });
      assert.equal(escape.isError, true);

      const web = listed.data.sources.find((s: { relPath: string }) => s.relPath === "web/AGENTS.md");
      const webRead = await call(client, "source_read", { sourceId: web.sourceId });
      const submitted = await call(client, "findings_submit", {
        projectId,
        findings: [
          {
            checkId: "S01", title: "Package manager differs", message: "Root says npm and web says pnpm; this may be intended layering.", severity: "info", confidence: "low",
            evidence: [
              { sourceId: root.sourceId, versionId: read.data.versionId, startLine: 2, endLine: 2, quote: "- Use npm to run scripts." },
              { sourceId: web.sourceId, versionId: webRead.data.versionId, startLine: 2, endLine: 2, quote: "- Use pnpm to run scripts." },
            ],
          },
          { checkId: "S03", title: "Bad quote", message: "x", severity: "warn", confidence: "low", evidence: [{ sourceId: root.sourceId, versionId: read.data.versionId, startLine: 2, endLine: 2, quote: "invented text" }] },
        ],
      });
      assert.equal(submitted.data.accepted.length, 1);
      assert.equal(submitted.data.rejected[0].errors[0].code, "quote_mismatch");
      const badSeverity = await client.callTool({ name: "findings_submit", arguments: { projectId, findings: [{ checkId: "S03", title: "t", message: "m", severity: "error", confidence: "low", evidence: [] }] } });
      assert.equal(badSeverity.isError, true, "schema rejects error severity from assistants");

      const findings = await call(client, "findings_list", { projectId, kind: "semantic" });
      assert.equal(findings.data.findings[0].claim, "possible");

      const before = await readFile(path.join(fx.root, "AGENTS.md"), "utf8");
      const proposed = await call(client, "change_propose", {
        projectId, sourceId: root.sourceId, baseVersionId: read.data.versionId, findingIds: [submitted.data.accepted[0]], rationale: "Align with web package",
        edits: [{ startLine: 2, endLine: 2, expectedText: "- Use npm to run scripts.", replacementLines: ["- Use pnpm to run scripts."] }],
      });
      assert.equal(proposed.isError, false, JSON.stringify(proposed.data));
      assert.equal(proposed.data.status, "pending");
      const leaked = JSON.stringify(proposed.data);
      const stored = fx.store.getProposal(proposed.data.proposalId);
      assert.ok(stored);
      assert.ok(!leaked.includes(stored.body.proposalSha256.slice(0, 12)), "the confirmation code is never sent to the assistant");
      const redactedEdit = await call(client, "change_propose", {
        projectId, sourceId: root.sourceId, baseVersionId: read.data.versionId, rationale: "touch secret line",
        edits: [{ startLine: 3, endLine: 3, expectedText: read.data.lines[2].text, replacementLines: ["- removed"] }],
      });
      assert.equal(redactedEdit.isError, true);

      const status = await call(client, "change_status", { proposalId: proposed.data.proposalId });
      assert.equal(status.data.status, "pending");
      assert.equal(await readFile(path.join(fx.root, "AGENTS.md"), "utf8"), before);
      assert.equal(before, ROOT_TEXT);
      assert.deepEqual((await readdir(fx.root)).sort(), [".env", "AGENTS.md", "web"]);
      assert.equal(fx.store.listApprovals(proposed.data.proposalId).length, 0);
    } finally {
      await client?.close();
      await fx.cleanup();
    }
  });
}

test("MCP entrypoint without a workspace flag uses <home>/.agentsol", async () => {
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const home = await mkdtemp(path.join(tmpdir(), "agentsol-home-"));
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: REPO, stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: home } });
    client = new Client({ name: "agentsol-test-client", version: "0.0.0" });
    await client.connect(transport);
    const r = await client.callTool({ name: "projects_list", arguments: {} });
    assert.equal(r.isError ?? false, false);
    assert.ok((await stat(path.join(home, ".agentsol"))).isDirectory());
  } finally {
    await client?.close();
    await rm(home, { recursive: true, force: true });
  }
});
