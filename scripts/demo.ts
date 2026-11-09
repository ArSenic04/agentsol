/**
 * Creates a synthetic demo project and workspace, then walks the MCP server over real
 * stdio the way an assistant would: list, scan, read, submit a finding, propose a change.
 * It never touches real projects and never approves or applies anything.
 *
 *   npm run demo                 # creates $TMPDIR/agentsol-demo, or shows the existing demo and its next steps
 *   npm run demo -- --dir <dir>  # somewhere else (must be empty or an earlier demo)
 *   npm run demo -- --reset      # recreate an earlier demo; refuses if it holds proposals
 *   npm run demo -- --reset --discard-proposals   # recreate even though proposals would be lost
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { validateProjectRoot } from "../src/core/projectRoots.ts";
import { DB_FILE, WorkspaceStore } from "../src/core/store.ts";
import { DEMO_FILES, DEMO_MARKER, LEGACY_DEMO_MARKERS } from "./demoFixture.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

type Args = { dir: string; reset: boolean; discardProposals: boolean };
function parseArgs(argv: string[]): Args {
  const i = argv.indexOf("--dir");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  return { dir: path.resolve(dir ?? path.join(tmpdir(), "agentsol-demo")), reset: argv.includes("--reset"), discardProposals: argv.includes("--discard-proposals") };
}

const cliFor = (wsDir: string): string => `npm run cli -- --workspace "${wsDir}"`;

function printNextSteps(wsDir: string, proposalIds: string[]): void {
  const cli = cliFor(wsDir);
  say("Next, as a person in your own terminal (not through an assistant):");
  say(`  ${cli} status`);
  for (const id of proposalIds) {
    say(`  ${cli} review ${id}`);
    say(`  ${cli} approve ${id}     # shows the diff again, then asks you to type a one-time code`);
    say(`  ${cli} apply ${id}       # writes the synthetic demo file; a backup is kept`);
  }
  say(`\nCheck your setup:  npm run doctor -- --workspace "${wsDir}"`);
  say(`MCP server command (for a client you configure yourself; nothing is installed for you):\n  ${process.execPath} ${path.join(REPO, "src/mcp/main.ts")} --workspace "${wsDir}"`);
}

/** What an earlier demo holds, read through the same services the CLI uses. Never modifies it except schema upgrade. */
type Existing = { proposals: { id: string; status: string }[] };
function inspectExisting(wsDir: string): Existing {
  if (!existsSync(path.join(wsDir, DB_FILE))) return { proposals: [] };
  const store = WorkspaceStore.open(wsDir);
  try {
    const proposals = store.listProjects().flatMap((p) => store.listProposals(p.id).map((x) => ({ id: x.body.id, status: x.status })));
    return { proposals };
  } finally {
    store.close();
  }
}

/** Returns "created" when a new demo folder was prepared, or "existing" when an earlier demo was kept. */
async function prepare(args: Args): Promise<"created" | "existing"> {
  const { dir, reset } = args;
  if (existsSync(dir)) {
    const isDemo = [DEMO_MARKER, ...LEGACY_DEMO_MARKERS].some((m) => existsSync(path.join(dir, m)));
    if (!isDemo) {
      if (readdirSync(dir).length > 0) throw new UserFacing(`${dir} exists and is not an Agentsol demo folder; refusing to touch it. Pick another folder with --dir.`);
    } else {
      const existing = inspectExisting(path.join(dir, "workspace"));
      if (!reset) return "existing";
      if (existing.proposals.length > 0 && !args.discardProposals) {
        const list = existing.proposals.map((p) => `${p.id} (${p.status})`).join(", ");
        throw new UserFacing(`The demo at ${dir} holds ${existing.proposals.length} proposal(s): ${list}. --reset would delete them, so nothing was changed. Review them first, or rerun with --reset --discard-proposals to start over.`);
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, DEMO_MARKER), "Created by `npm run demo`. Safe to delete.\n");
  for (const [rel, content] of Object.entries(DEMO_FILES)) {
    const abs = path.join(dir, "project", rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, { flag: "wx" });
  }
  return "created";
}

/** An expected, explained refusal: printed without a stack trace. */
class UserFacing extends Error {}

async function showExisting(dirReal: string, custom: boolean): Promise<void> {
  const wsDir = path.join(dirReal, "workspace");
  const { proposals } = inspectExisting(wsDir);
  say(`A demo already exists at ${dirReal}; it was kept as is (nothing reset).`);
  say(`Demo project:   ${path.join(dirReal, "project")}`);
  say(`Demo workspace: ${wsDir}\n`);
  if (proposals.length === 0) say("It has no proposals yet.");
  for (const p of proposals) say(`  proposal ${p.id}: ${p.status}`);
  say("");
  printNextSteps(wsDir, proposals.filter((p) => p.status === "pending").map((p) => p.id));
  say(`\nStart over: npm run demo --${custom ? ` --dir "${dirReal}"` : ""} --reset${proposals.length > 0 ? " --discard-proposals   (deletes the proposals listed above)" : ""}`);
}

type ToolText = { data: any; isError: boolean };
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolText> {
  const r = await client.callTool({ name, arguments: args });
  const first = r.content[0];
  if (!first || first.type !== "text") throw new Error(`${name} returned no text`);
  return { data: JSON.parse(first.text), isError: r.isError === true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prepared = await prepare(args);
  const dirReal = await realpath(args.dir);
  if (prepared === "existing") return showExisting(dirReal, process.argv.includes("--dir"));
  const projectDir = path.join(dirReal, "project");
  const wsDir = path.join(dirReal, "workspace");

  const store = WorkspaceStore.open(wsDir);
  let projectId: string;
  try {
    const root = await validateProjectRoot({ candidate: projectDir, homeReal: await realpath(homedir()), workspaceDir: wsDir });
    if (!root.ok) throw new UserFacing(root.error);
    projectId = store.addProject({ name: "paper-lantern-demo", rootReal: root.value }).id;
    store.audit({ actor: "demo-script", action: "project_registered", entityId: projectId });
  } finally {
    store.close();
  }
  say(`Demo project:   ${projectDir}`);
  say(`Demo workspace: ${wsDir}\n`);

  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "src/mcp/main.ts"), "--workspace", wsDir], cwd: REPO, stderr: "pipe" });
  const client = new Client({ name: "agentsol-demo", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  try {
    say(`MCP protocol ${client.getNegotiatedProtocolVersion()}; tools: ${(await client.listTools()).tools.map((t) => t.name).join(", ")}\n`);
    const scan = await call(client, "sources_scan", { projectId });
    say(`Scan: ${scan.data.sources} instruction files, ${scan.data.structuralFindings} structural findings, skipped ${scan.data.skipped.secretLike} secret-like name(s) without naming them`);
    const listed = await call(client, "sources_list", { projectId });
    for (const s of listed.data.sources) say(`  read      ${s.relPath}`);
    for (const e of listed.data.notRead) say(`  not read  ${e.relPath} (${e.reason})`);
    const findings = await call(client, "findings_list", { projectId });
    say("\nStructural findings (facts):");
    for (const f of findings.data.findings) say(`  ${f.checkId} ${f.severity.padEnd(5)} ${f.evidence[0].relPath}:${f.evidence[0].startLine}  ${f.message}`);

    const root = listed.data.sources.find((s: { relPath: string }) => s.relPath === "AGENTS.md");
    const api = listed.data.sources.find((s: { relPath: string }) => s.relPath === "services/api/AGENTS.md");
    const rootRead = await call(client, "source_read", { sourceId: root.sourceId });
    const apiRead = await call(client, "source_read", { sourceId: api.sourceId });
    say(`\nWhat the assistant sees for AGENTS.md line 5: ${rootRead.data.lines[4].text}`);

    const submitted = await call(client, "findings_submit", {
      projectId,
      findings: [{
        checkId: "S01", title: "Package manager differs", severity: "info", confidence: "medium",
        message: "The root says npm and services/api says pnpm. This may be intended layering; confirm which applies in services/api.",
        evidence: [
          { sourceId: root.sourceId, versionId: rootRead.data.versionId, startLine: 3, endLine: 3, quote: "- Use npm to run scripts." },
          { sourceId: api.sourceId, versionId: apiRead.data.versionId, startLine: 3, endLine: 3, quote: "- Use pnpm to run scripts in this package." },
        ],
      }],
    });
    say(`Assistant-reported possible finding accepted: ${submitted.data.accepted[0]}`);

    const proposal = await call(client, "change_propose", {
      projectId, sourceId: root.sourceId, baseVersionId: rootRead.data.versionId, findingIds: submitted.data.accepted,
      rationale: "Say explicitly that services/api uses pnpm.",
      edits: [{ startLine: 3, endLine: 3, expectedText: "- Use npm to run scripts.", replacementLines: ["- Use npm to run scripts (services/api uses pnpm)."] }],
    });
    if (proposal.isError) throw new Error(JSON.stringify(proposal.data));
    say(`\nProposed change (nothing written yet):\n${proposal.data.diff}\n`);
    const id = proposal.data.proposalId;
    printNextSteps(wsDir, [id]);
    say(`\nDelete the demo any time: rm -rf "${dirReal}"`);
  } finally {
    await client.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof UserFacing) process.stderr.write(`demo: ${e.message}\n`);
  else process.stderr.write(`demo: unexpected failure: ${e instanceof Error ? e.message : String(e)}\nRun: npm run doctor\n`);
  process.exitCode = 1;
});
