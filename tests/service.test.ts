import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LIMITS } from "../src/core/limits.ts";
import { createAssistantService } from "../src/core/service/assistant.ts";
import { fixture, sourceByPath, tempDir, withoutTimes, writeTree, type Fixture } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "src", "cli", "main.ts");
const SERVER = path.join(REPO, "src", "mcp", "main.ts");
const FAKE_SECRET = "sk-FAKEFAKEFAKEFAKEFAKEFAKE1234567890";

const cli = (ws: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, "--workspace", ws, ...args], { cwd: REPO, encoding: "utf8", input: "", timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: homedir() } });
const cliJson = (ws: string, ...args: string[]): unknown => {
  const r = cli(ws, ...args, "--json");
  return JSON.parse(r.stdout);
};

type Sunk = { op: string; error: unknown }[];
const service = (fx: Fixture, sunk: Sunk = []) =>
  createAssistantService(fx.store, { reporter: () => "assistant:test", onInternalError: (op, error) => sunk.push({ op, error }) });

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) assert.fail(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
function errorCode(r: { ok: boolean; error?: { code: string } }): string {
  assert.equal(r.ok, false, "expected an error");
  return r.error?.code ?? "";
}

async function connect(ws: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--workspace", ws], cwd: REPO, stderr: "pipe" });
  const client = new Client({ name: "agentsol-equivalence-test", version: "0.0.0" }, { versionNegotiation: { mode: "legacy" } });
  await client.connect(transport);
  return client;
}
async function mcp(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: unknown }> {
  const r = await client.callTool({ name, arguments: args });
  const first = r.content[0];
  assert.ok(first && first.type === "text");
  return { isError: r.isError === true, data: JSON.parse(first.text) };
}

/** Walks relative static and dynamic imports from an entry file. */
async function importGraph(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = m[1];
      if (spec) queue.push(path.resolve(path.dirname(file), spec));
    }
  }
  return seen;
}

test("approve/apply code is unreachable from the MCP entrypoint, the web bridge and the assistant service", async () => {
  const forbidden = [path.join(REPO, "src/core/humanApproval.ts"), path.join(REPO, "src/core/service/operator.ts")];
  const fromMcp = await importGraph(SERVER);
  const fromAssistant = await importGraph(path.join(REPO, "src/core/service/assistant.ts"));
  assert.ok(fromMcp.has(path.join(REPO, "src/core/service/assistant.ts")), "graph walk actually follows imports");
  assert.ok(fromMcp.size > 10);
  for (const f of forbidden) {
    assert.ok(!fromMcp.has(f), `${path.relative(REPO, f)} reachable from MCP`);
    assert.ok(!fromAssistant.has(f), `${path.relative(REPO, f)} reachable from the assistant service`);
  }
  const fromWeb = await importGraph(path.join(REPO, "src/web/main.ts"));
  assert.ok(fromWeb.has(path.join(REPO, "src/core/service/assistant.ts")));
  for (const f of forbidden) assert.ok(!fromWeb.has(f), `${path.relative(REPO, f)} reachable from the local web bridge`);
  const fromCli = await importGraph(CLI);
  assert.ok(forbidden.every((f) => fromCli.has(f)), "the CLI is where human decisions live");
});

test("assistant service surface has no approve, reject, apply, register or write-file capability", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n" });
  try {
    const svc = service(fx);
    const keys = Object.keys(svc).sort();
    assert.deepEqual(keys, ["briefing", "commandCheck", "freshness", "gradeSession", "lessons", "listFindings", "listProjects", "listProposals", "listSources", "projectStatus", "proposalStatus", "proposeChange", "readSource", "resolveScope", "runChecks", "scan", "sessionReview", "sessionsList", "setupAudit", "status", "submitFindings"]);
    assert.ok(Object.isFrozen(svc));
    assert.ok(!keys.some((k) => /approv|apply|reject|register|addProject|write|delete|reconcile/i.test(k)));
  } finally {
    await fx.cleanup();
  }
});

test("CLI --json and MCP return identical results from the same workspace", async () => {
  const fx = await fixture({
    "AGENTS.md": `# Root\n- Use npm to run scripts.\n- key ${FAKE_SECRET}\n`,
    "web/AGENTS.md": "# Web\n- Use pnpm to run scripts.\n",
    "CLAUDE.local.md": "personal\n",
  });
  let client: Client | undefined;
  try {
    client = await connect(fx.wsDir);
    const projectId = fx.projectId;
    assert.equal((await mcp(client, "sources_scan", { projectId })).isError, false);
    const pairs: [string, Record<string, unknown>, string[]][] = [
      ["sources_list", { projectId }, ["sources", projectId]],
      ["findings_list", { projectId }, ["findings", projectId]],
      ["workspace_status", {}, ["status"]],
      ["sources_freshness", { projectId }, ["freshness", projectId]],
    ];
    for (const [tool, args, cliArgs] of pairs) {
      const viaMcp = await mcp(client, tool, args);
      assert.equal(viaMcp.isError, false, tool);
      assert.deepEqual(withoutTimes(cliJson(fx.wsDir, ...cliArgs)), withoutTimes(viaMcp.data), `${tool} equals CLI ${cliArgs.join(" ")} --json`);
    }
    const status = await mcp(client, "workspace_status", {});
    assert.ok(!JSON.stringify(status.data).includes(fx.root), "status has no absolute paths");
    assert.ok(!JSON.stringify(status.data).includes("Use npm"), "status has no file text");
    // Errors are the same public objects on both transports.
    const missing = "prj_0000000000000000";
    const mcpErr = await mcp(client, "sources_list", { projectId: missing });
    assert.equal(mcpErr.isError, true);
    const cliErr = cli(fx.wsDir, "sources", missing, "--json");
    assert.notEqual(cliErr.status, 0);
    assert.deepEqual(JSON.parse(cliErr.stdout), mcpErr.data);
  } finally {
    await client?.close();
    await fx.cleanup();
  }
});

test("projects are isolated; one project going stale does not affect another", async () => {
  const a = await fixture({ "AGENTS.md": "# A\n- Use npm.\n" });
  const bRoot = path.join(await tempDir("b"), "project-b");
  try {
    await mkdir(bRoot);
    await writeTree(bRoot, { "AGENTS.md": "# B\n- Use yarn.\n" });
    const b = a.store.addProject({ name: "b", rootReal: bRoot });
    const svc = service(a);
    value(await svc.scan({ projectId: a.projectId }));
    value(await svc.scan({ projectId: b.id }));
    const aSrc = sourceByPath(a.store, a.projectId, "AGENTS.md");
    const bSrc = sourceByPath(a.store, b.id, "AGENTS.md");

    // Cross-project ids are refused, not silently resolved.
    const cross = svc.proposeChange({ projectId: a.projectId, sourceId: bSrc.source.id, baseVersionId: bSrc.version.id, rationale: "x", edits: [{ startLine: 2, endLine: 2, expectedText: "- Use yarn.", replacementLines: ["- Use npm."] }] });
    assert.equal(errorCode(cross), "wrong_project");
    const crossFinding = svc.submitFindings({ projectId: a.projectId, findings: [{ checkId: "S03", title: "t", message: "m", severity: "info", confidence: "low", evidence: [{ sourceId: bSrc.source.id, versionId: bSrc.version.id, startLine: 2, endLine: 2, quote: "- Use yarn." }] }] });
    assert.equal(errorCode(crossFinding), "rejected");
    assert.match(JSON.stringify(crossFinding), /wrong_project/);

    const quoteA = { sourceId: aSrc.source.id, versionId: aSrc.version.id, startLine: 2, endLine: 2, quote: "- Use npm." };
    const quoteB = { sourceId: bSrc.source.id, versionId: bSrc.version.id, startLine: 2, endLine: 2, quote: "- Use yarn." };
    value(svc.submitFindings({ projectId: a.projectId, findings: [{ checkId: "S03", title: "A vague", message: "maybe", severity: "info", confidence: "low", evidence: [quoteA] }] }));
    value(svc.submitFindings({ projectId: b.id, findings: [{ checkId: "S03", title: "B vague", message: "maybe", severity: "info", confidence: "low", evidence: [quoteB] }] }));
    value(svc.proposeChange({ projectId: a.projectId, sourceId: aSrc.source.id, baseVersionId: aSrc.version.id, rationale: "pnpm", edits: [{ startLine: 2, endLine: 2, expectedText: "- Use npm.", replacementLines: ["- Use pnpm."] }] }));
    const bBefore = value(await svc.projectStatus({ projectId: b.id }));

    await writeFile(path.join(a.root, "AGENTS.md"), "# A\n- Use bun.\n");
    value(await svc.scan({ projectId: a.projectId }));

    const aAfter = value(await svc.projectStatus({ projectId: a.projectId }));
    assert.equal(aAfter.findings.semantic, 0);
    assert.equal(aAfter.findings.staleHidden >= 1, true, "A's old finding is counted as stale, not shown as current");
    assert.equal(aAfter.proposals.pending, 1);
    assert.equal(aAfter.proposals.pendingOnOldVersion, 1, "A's proposal is flagged as targeting an old version");
    assert.equal(value(svc.listFindings({ projectId: a.projectId, kind: "semantic" })).findings.length, 0);

    const bAfter = value(await svc.projectStatus({ projectId: b.id }));
    assert.deepEqual(withoutTimes(bAfter), withoutTimes(bBefore), "B is unaffected by A changing");
    assert.equal(bAfter.freshness.state, "no_known_changes");
    assert.equal(aAfter.freshness.state, "no_known_changes", "A was rescanned after the edit");
    assert.equal(bAfter.findings.semantic, 1);
    assert.equal(bAfter.findings.staleHidden, 0);
    assert.equal(value(await svc.status()).projects.length, 2);
  } finally {
    await a.cleanup();
    await rm(path.dirname(bRoot), { recursive: true, force: true });
  }
});

test("request keys replay the same result and refuse a different request with the same key", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n- Use npm.\n- Be careful.\n" });
  try {
    const svc = service(fx);
    value(await svc.scan({ projectId: fx.projectId }));
    const src = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const quote = { sourceId: src.source.id, versionId: src.version.id, startLine: 3, endLine: 3, quote: "- Be careful." };
    const finding = { checkId: "S03", title: "Vague", message: "Possibly vague", severity: "info", confidence: "low", evidence: [quote] };

    const first = value(svc.submitFindings({ projectId: fx.projectId, findings: [finding], requestKey: "find-0001" }));
    assert.equal(first.replayed, false);
    const again = value(svc.submitFindings({ projectId: fx.projectId, findings: [finding], requestKey: "find-0001" }));
    assert.equal(again.replayed, true);
    assert.deepEqual(again.accepted, first.accepted);
    const conflict = svc.submitFindings({ projectId: fx.projectId, findings: [{ ...finding, title: "Other" }], requestKey: "find-0001" });
    assert.equal(errorCode(conflict), "request_key_conflict");
    const noKey = value(svc.submitFindings({ projectId: fx.projectId, findings: [finding] }));
    assert.deepEqual(noKey.duplicates, first.accepted, "identical content without a key returns the existing id");
    assert.equal(fx.store.listFindings(fx.projectId).filter((f) => f.kind === "semantic").length, 1);

    const edit = { startLine: 2, endLine: 2, expectedText: "- Use npm.", replacementLines: ["- Use pnpm."] };
    const base = { projectId: fx.projectId, sourceId: src.source.id, baseVersionId: src.version.id, rationale: "pnpm", edits: [edit] };
    // A failed request does not consume its key.
    const bad = svc.proposeChange({ ...base, edits: [{ ...edit, expectedText: "wrong" }], requestKey: "prop-0001" });
    assert.equal(bad.ok, false);
    const p1 = value(svc.proposeChange({ ...base, requestKey: "prop-0001" }));
    assert.equal(p1.replayed, false);
    const p2 = value(svc.proposeChange({ ...base, requestKey: "prop-0001" }));
    assert.equal(p2.replayed, true);
    assert.equal(p2.proposalId, p1.proposalId);
    assert.equal(p2.diff, p1.diff);
    assert.equal(errorCode(svc.proposeChange({ ...base, rationale: "different", requestKey: "prop-0001" })), "request_key_conflict");
    const p3 = value(svc.proposeChange(base));
    assert.equal(p3.duplicateOfExisting, true);
    assert.equal(p3.proposalId, p1.proposalId);
    const p4 = value(svc.proposeChange({ ...base, requestKey: "prop-0002" }));
    assert.equal(p4.proposalId, p1.proposalId, "a new key for the same pending change still does not create a second proposal");
    assert.equal(fx.store.listProposals(fx.projectId).length, 1);
    assert.equal(errorCode(svc.proposeChange({ ...base, requestKey: "short" })), "invalid_input");
  } finally {
    await fx.cleanup();
  }
});

test("public errors are sanitized: no stack traces, no absolute paths", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n- one\n" });
  const sunk: Sunk = [];
  try {
    const svc = service(fx, sunk);
    value(await svc.scan({ projectId: fx.projectId }));
    const src = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    assert.equal(errorCode(svc.readSource({ sourceId: 5 })), "invalid_input");
    assert.equal(errorCode(svc.readSource({ sourceId: src.source.id, startLine: 99 })), "invalid_input", "start past EOF is an error, not an empty read");
    assert.equal(errorCode(svc.proposalStatus({ proposalId: "chg_0000000000000000" })), "not_found");
    assert.equal(errorCode(svc.resolveScope({ projectId: fx.projectId, targetPath: "../../etc/passwd", platform: "codex" })), "invalid_input");

    await rm(fx.root, { recursive: true, force: true });
    const gone = await svc.scan({ projectId: fx.projectId });
    assert.equal(errorCode(gone), "root_unavailable");
    assert.ok(!JSON.stringify(gone).includes(fx.root), "root path not disclosed");
    const st = value(await svc.projectStatus({ projectId: fx.projectId }));
    assert.equal(st.scan.state, "refused");
    assert.ok(!JSON.stringify(st).includes(fx.root));

    fx.store.close();
    const broken = svc.listProjects();
    assert.equal(errorCode(broken), "internal_error");
    const text = JSON.stringify(broken);
    assert.ok(!/\/(Users|private|var|tmp)\//.test(text), text);
    assert.ok(!/\bat\s+\S+\s+\(|\.ts:\d+/.test(text), "no stack frames");
    assert.equal(sunk.length, 1, "details went to the local sink");
  } finally {
    await rm(path.dirname(fx.root), { recursive: true, force: true });
  }
});

test("status represents never-scanned, partial, presence-only and redacted data instead of implying clean", async () => {
  let deep = "";
  for (let i = 0; i <= LIMITS.maxDepth + 1; i++) deep += `d${i}/`;
  const fx = await fixture({
    "AGENTS.md": `# Root\n- key ${FAKE_SECRET}\n`,
    "node_modules/pkg/AGENTS.md": "# dep\n",
    "dist/AGENTS.md": "# built\n",
    "sub/agents.md": "# lower-case variant\n",
    [`${deep}AGENTS.md`]: "# too deep\n",
  });
  try {
    await symlink("AGENTS.md", path.join(fx.root, "CLAUDE.md"));
    const svc = service(fx);
    const before = value(await svc.projectStatus({ projectId: fx.projectId }));
    assert.deepEqual(before.scan, { state: "never_scanned" });
    assert.equal(before.sources.present, 0);

    value(await svc.scan({ projectId: fx.projectId }));
    const st = value(await svc.projectStatus({ projectId: fx.projectId }));
    assert.equal(st.scan.state, "scanned");
    if (st.scan.state !== "scanned") return;
    assert.equal(st.scan.partial, true);
    const reasons = st.scan.partialReasons.join("\n");
    assert.match(reasons, /deeper than the depth limit/);
    assert.match(reasons, /generated or dependency folder/);
    assert.match(reasons, /symlink/);
    assert.match(reasons, /case_variant_name/);
    assert.equal(st.sources.present, 1);
    assert.equal(st.sources.withRedactedLines, 1);
    assert.equal(st.notRead.byReason.case_variant_name, 1);
    assert.equal(st.notRead.byReason.symlink_not_followed, 1);
    assert.ok(value(await svc.status()).caveats.some((c) => /does not mean/.test(c)));

    const scope = value(svc.resolveScope({ projectId: fx.projectId, targetPath: "src/x.ts", platform: "claude-code" }));
    assert.equal(scope.coverage, "partial");
    assert.ok(JSON.stringify(scope).includes("CLAUDE.md"), "the symlinked CLAUDE.md is reported as present but not read");
  } finally {
    await fx.cleanup();
  }
});
