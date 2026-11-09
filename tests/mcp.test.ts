import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture, type Fixture } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "src", "mcp", "main.ts");
const FAKE_SECRET = "sk-FAKEFAKEFAKEFAKEFAKEFAKE1234567890";
const ROOT_TEXT = `# Root\n- Use npm to run scripts.\n- Demo key ${FAKE_SECRET}\n`;
const EXPECTED_TOOLS = ["change_propose", "change_status", "checks_run", "findings_list", "findings_submit", "projects_list", "scope_resolve", "source_read", "sources_list", "sources_scan"];

type Mode = "legacy" | "auto";

async function connect(fx: Fixture, mode: Mode): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--workspace", fx.wsDir], cwd: REPO, stderr: "pipe" });
  const client = new Client({ name: "agentweave-test-client", version: "0.0.0" }, { versionNegotiation: { mode } });
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
      assert.match(client.getInstructions() ?? "", /only the human can approve and apply/i);

      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, EXPECTED_TOOLS);
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
      assert.ok(listed.data.excluded.some((e: { relPath: string; reason: string }) => e.relPath === ".env" && e.reason === "secret_like_name"));

      const read = await call(client, "source_read", { sourceId: root.sourceId });
      assert.ok(!JSON.stringify(read.data).includes(FAKE_SECRET), "secret never crosses MCP");
      assert.deepEqual(read.data.redactedLines, [3]);
      assert.equal(read.data.lines[1].text, "- Use npm to run scripts.");
      assert.match(read.data.notice, /leaves this machine/);

      const bogusRead = await call(client, "source_read", { sourceId: "../../etc/passwd" });
      assert.equal(bogusRead.isError, true);

      const scope = await call(client, "scope_resolve", { projectId, targetPath: "web/app.ts", platform: "codex" });
      assert.deepEqual(scope.data.chain.map((c: { relPath: string }) => c.relPath), ["AGENTS.md", "web/AGENTS.md"]);
      assert.equal(scope.data.relationship, "layered");
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

test("MCP entrypoint refuses to start without an explicit workspace", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [SERVER], { cwd: REPO, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--workspace/);
});

test("MCP code never imports the human approval module", async () => {
  const dir = path.join(REPO, "src", "mcp");
  for (const f of await readdir(dir)) {
    const text = await readFile(path.join(dir, f), "utf8");
    assert.ok(!/humanApproval/.test(text), `${f} must not import humanApproval`);
  }
});
