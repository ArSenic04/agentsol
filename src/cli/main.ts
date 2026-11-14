/**
 * Local CLI for the person who owns the workspace. Read and propose operations go
 * through the same assistant-safe service as MCP; human-only decisions go through the
 * operator service. All output is sanitized because file text and rationale are untrusted.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectAgentEnvironment } from "../core/agentEnv.ts";
import type { ProjectFreshness } from "../core/freshness.ts";
import { runDoctor } from "./doctor.ts";
import { sanitizeForTerminal } from "../core/display.ts";
import { STRUCTURAL_CHECKS } from "../core/checks.ts";
import { handoffPrompt } from "../core/handoff.ts";
import { inspectFiles, type InspectFile, type InspectReport } from "../core/risks.ts";
import { secretIn } from "../core/secrets.ts";
import { isProposalId } from "../core/ids.ts";
import { LIMITS } from "../core/limits.ts";
import type { Finding } from "../core/schemas.ts";
import { SEMANTIC_CHECKS } from "../core/semantic.ts";
import { createAssistantService, type AssistantService } from "../core/service/assistant.ts";
import type { ServiceResult } from "../core/service/errors.ts";
import { createOperatorService, type Review } from "../core/service/operator.ts";
import type { ProjectStatus } from "../core/service/status.ts";
import { listSessions, overallScore, parseSince, reviewSession, RUBRIC_KEYS, SESSION_CHECKS, SessionIdSchema, StoredGradeSchema, type SessionSummary, type Verdict } from "../core/sessions.ts";
import { auditSetup, SETUP_CHECKS, type SetupReport } from "../core/setup.ts";
import { WorkspaceStore, type Project } from "../core/store.ts";
import { resolveWorkspace } from "../core/workspaceArg.ts";
import { PRODUCT_VERSION } from "../core/version.ts";
import { PROMPT_NAMES, TOOL_NAMES } from "../mcp/server.ts";
import { banner, detectTerm, fit, heading, pairs, panel, render, withSpinner, wrapWords, type Seg, type Term } from "./tui.ts";

const USAGE = `agentsol [--workspace <dir>] <command> [--json]
agentsol --version

The workspace defaults to <home>/.agentsol (or AGENTSOL_WORKSPACE).

Start here:
  check [path] [--strict] [--json]      register the folder (default: this one), scan it and show cited findings
  connect [client]                      print MCP setup for claude-code, codex, gemini, vscode, cursor, claude-desktop, windsurf
  prompt [path]                         print one masked prompt to paste into any chat AI
  inspect <folder|file> [--json]        before you install a skill or MCP server: scan its files or its tool
                                        list (tools/list JSON) for hidden instructions, credential theft and more
  learn [path] [--since 30d] [--propose] [--json]
                                        mistakes your agents repeat here (wrong commands, things you keep telling
                                        them, files they keep breaking), the time they cost, and rules that stop them
  sessions [path] [--since 7d] [--limit N] [--json]
                                        what your AI agents did lately (Claude Code, Codex), with risky steps flagged
  session <id> [--timeline] [--from N] [--json]
                                        one session in detail: findings, metrics, grades, step timeline

Commands (human-run, local only):
  doctor [--json] [--strict]            preflight (Node, packages, workspace, terminal) plus an audit of your AI apps'
                                        settings: plaintext secrets, MCP servers, permissions, hooks
  project add <path> [--name <name>]   register a project folder (never home, /, system or broad folders)
  projects                              list registered projects (with local paths)
  status [--json]                       workspace status: last-scan snapshot, partial coverage, disk freshness, proposals
  freshness <projectId> [--json]        per-file disk freshness since the last scan (metadata only; not proof)
  scan <projectId> [--json]             discover instruction files and run deterministic checks
  sources <projectId> [--json]          list sources and instruction files not read
  findings <projectId> [--json]         list current structural and possible (assistant-reported) findings
  proposals <projectId> [--json]        list proposals with diffs (read-only)
  review <proposalId>                   show a proposal's diff and fingerprint
  approve <proposalId>                  approve (interactive terminal only; type the one-time code shown)
  reject <proposalId>                   reject a proposal (interactive terminal only)
  apply <proposalId>                    apply an approved proposal (interactive terminal only)
  reconcile <proposalId>                resolve a proposal stuck in "applying" after a crash
  audit [entityId]                      show the audit log
`;

const out = (s: string): void => {
  process.stdout.write(`${sanitizeForTerminal(s)}\n`);
};
const fail = (s: string, code = 1): number => {
  process.stderr.write(`agentsol: ${sanitizeForTerminal(s)}\n`);
  return code;
};
const actor = (): string => `local-user:${userInfo().username}`;
const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Reads one line from the terminal. Ctrl+C, Ctrl+D or a closed input count as "cancel". */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    process.stdout.write("\n");
    return "";
  } finally {
    rl.close();
  }
}

const humanOnly = (command: string): number | null => {
  const agent = detectAgentEnvironment(process.env);
  if (agent) return fail(`${command} is for a person, and this terminal looks like it is run by ${agent.agent} (${agent.variable} is set). Run it yourself in a normal terminal.`, 2);
  if (!isInteractive()) return fail(`${command} must be run by a person in an interactive terminal`, 2);
  return null;
};

/** Prints a service result: JSON when asked, otherwise a text renderer. */
function show<T>(r: ServiceResult<T>, json: boolean, text: (v: T) => void): number {
  if (!r.ok) {
    if (json) process.stdout.write(`${JSON.stringify({ error: r.error }, null, 2)}\n`);
    return fail(`${r.error.code}: ${r.error.message}`, r.error.code === "invalid_input" || r.error.code === "not_found" ? 2 : 1);
  }
  if (json) process.stdout.write(`${JSON.stringify(r.value, null, 2)}\n`);
  else text(r.value);
  return 0;
}

const localTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleString()} (local time)`;
};

function describeFreshness(f: ProjectFreshness): string {
  switch (f.state) {
    case "not_checked":
      return "not checked (never scanned)";
    case "unknown":
      return f.reason === "root_replaced" ? "UNKNOWN: a different folder now sits at the registered path; scans refuse until you confirm it with project add <path>"
        : f.reason === "root_unavailable" ? "UNKNOWN: the project folder is missing, moved or now a symlink"
        : "UNKNOWN: no disk metadata from the last scan (scanned with an older version); scan again";
    default: {
      const c = f.counts;
      const detail = `${c.changed} changed, ${c.removed} removed, ${c.unsafe} unsafe, ${c.unknown} unknown, ${c.metadata_unchanged} with unchanged metadata`;
      return f.state === "changes_detected" ? `CHANGES DETECTED since the last scan (${detail}); findings may be out of date, scan again`
        : f.state === "incomplete" ? `incomplete (${detail}); scan again to refresh`
        : `no known changes (${detail}); not proof of no change, and new files need a scan`;
    }
  }
}

function renderStatus(p: ProjectStatus): void {
  const scan = p.scan.state === "never_scanned" ? "never scanned: nothing is known yet"
    : p.scan.state === "refused" ? `scan refused at ${localTime(p.scan.at)}: ${p.scan.reason}`
    : `scanned ${localTime(p.scan.at)}${p.scan.partial ? " (PARTIAL coverage)" : ""}`;
  out(`${p.projectId}  ${p.name}\n  ${scan}`);
  if (p.scan.state === "scanned") for (const r of p.scan.partialReasons) out(`    - ${r}`);
  out(`  sources: ${p.sources.present} present, ${p.sources.missing} missing, ${p.sources.withRedactedLines} with redacted lines; ${p.notRead.total} instruction file(s) not read`);
  out(`  disk now: ${describeFreshness(p.freshness)}`);
  out(`  findings (last scan): ${p.findings.structural} structural, ${p.findings.semantic} possible, ${p.findings.staleHidden} hidden as stale`);
  const pr = p.proposals;
  out(`  proposals: ${pr.pending} pending (${pr.pendingOnOldVersion} on an old version), ${pr.applying} applying, ${pr.stale} stale, ${pr.applied} applied, ${pr.rejected} rejected`);
}

function renderReview(r: Review): void {
  const p = r.proposal;
  out(`proposal ${p.body.id}  status=${p.status}  file=${p.body.relPath}`);
  out(`author: ${p.body.author}   created: ${p.body.createdAt}`);
  out(`rationale: ${p.body.rationale}`);
  if (r.linkedFindings.length > 0) out(`linked findings: ${r.linkedFindings.join(", ")}`);
  if (!r.baseIsCurrent) out("WARNING: the source changed since this proposal was made; it cannot be applied.");
  out(r.diff);
  out("\nThe rationale and file text above were written by an assistant or a repository author. Read the diff itself before approving.");
  if (p.status === "pending") out(`fingerprint: ${r.fingerprint}`);
}

const raw = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
const HERE = fileURLToPath(import.meta.url);
/** How the person invoked us, so every hint is copy-pasteable. */
const CMD = /[\\/]_npx[\\/]/.test(HERE) ? "npx -y agentsol@alpha" : /[\\/]node_modules[\\/]/.test(HERE) ? "npx agentsol" : "agentsol";
const MCP_ARGS = ["-y", "-p", "agentsol@alpha", "agentsol-mcp"];
const tilde = (p: string): string => (p === homedir() ? "~" : p.startsWith(`${homedir()}${path.sep}`) ? `~${p.slice(homedir().length)}` : p);
const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const copyCmd = (): string => (process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard");

function projectFor(projects: readonly Project[], dirReal: string): Project | null {
  const hits = projects.filter((p) => dirReal === p.rootReal || dirReal.startsWith(`${p.rootReal}${path.sep}`));
  return hits.sort((a, b) => b.rootReal.length - a.rootReal.length)[0] ?? null;
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2 };
const ICON: Record<string, readonly [Seg, Seg]> = {
  error: [["bad", "✗"], ["bad", "error"]],
  warn: [["warn", "▲"], ["warn", "warn "]],
  info: [["info", "●"], ["info", "note "]],
};

function home(t: Term, ws: { dir: string; isDefault: boolean }): void {
  const exists = existsSync(path.join(ws.dir, "agentsol.db")) || existsSync(ws.dir);
  let here: Seg[] = [["muted", "not registered · "], ["bold", `${CMD} check`], ["muted", " registers and scans it"]];
  let projects = 0;
  if (exists) {
    try {
      const store = WorkspaceStore.open(ws.dir);
      try {
        const list = store.listProjects();
        projects = list.length;
        const p = projectFor(list, realpathSync(process.cwd()));
        if (p) {
          const st = store.listFindings(p.id).length;
          here = [["ok", "✓ "], ["bold", p.name], ["muted", ` · ${n(st, "finding")} recorded · `], ["bold", `${CMD} check`], ["muted", " to refresh"]];
        }
      } finally {
        store.close();
      }
    } catch {
      here = [["warn", "workspace could not be opened; run "], ["bold", `${CMD} doctor`]];
    }
  }
  const w = Math.min(t.width - 2, 96);
  const L = 16;
  const toolRows = wrapWords([...TOOL_NAMES], w - 4 - L, " · ");
  raw();
  for (const l of banner(t)) raw(l);
  raw(render(t, ["  ", ["muted", "Reviews your AI agents' work: the rules they follow, what they did, how they are set up."]]));
  raw();
  for (const l of panel(t, [["bold", "agentsol"], " ", ["muted", `${PRODUCT_VERSION} · free · MIT · local-first`]], [
    ...pairs([
      ["Workspace", exists ? [tilde(ws.dir), ["muted", ` · ${n(projects, "project")}`]] : [tilde(ws.dir), ["muted", " · created on first check"]]],
      ["This folder", here],
      ["Your AI", ["Claude · Codex · Gemini · Copilot · Cursor", ["muted", " · any MCP app"]]],
      ["Cost", ["$0", ["muted", " · no account, no API key, nothing hosted"]]],
    ], L),
    [],
    ...toolRows.map((r, i): Seg[] => [["muted", (i === 0 ? `Tools (${TOOL_NAMES.length})` : "").padEnd(L)], ["agent", r]]),
    [["muted", "Prompts".padEnd(L)], ["agent", PROMPT_NAMES.map((p) => `/${p}`).join("  ")], ["muted", "  · agentsol://guide"]],
    [["muted", "Checks".padEnd(L)], `${Object.keys(STRUCTURAL_CHECKS).length} instruction`, ["muted", " · "], `${Object.keys(SESSION_CHECKS).length} activity`, ["muted", " · "], `${Object.keys(SETUP_CHECKS).length} setup`, ["muted", " + "], `${Object.keys(SEMANTIC_CHECKS).length} for your AI to judge`],
    [["muted", "Guardrails".padEnd(L)], ["muted", "secrets masked · lines cited · diffs only · you approve"]],
  ], w)) raw(`  ${l}`);
  raw();
  raw(`  ${heading(t, "Commands")}`);
  const cmds: [string, string][] = [
    ["check [path]", "scan a project (default: this folder) and show cited findings"],
    ["connect [app]", "one-line MCP setup for your assistant"],
    ["prompt [path]", "one masked prompt for ChatGPT, Gemini, Claude.ai or any chat"],
    ["learn", "rules from mistakes your agents keep repeating here, and the time they cost"],
    ["sessions", "what your AI agents did: risky commands, exposed secrets, skipped tests"],
    ["doctor", "preflight plus your AI apps' setup: secrets, MCP servers, permissions"],
    ["review <id>", "read a proposed diff, then approve and apply it yourself"],
    ["help", "every command"],
  ];
  for (const [c, d] of cmds) raw(render(t, ["    ", ["bold", c.padEnd(16)], ["muted", d]]));
  raw();
  raw(render(t, ["  ", ["sun", "→ "], "Start with ", ["bold", `${CMD} check`], " inside a project."]));
  raw();
}

async function readAll(svc: AssistantService, sourceId: string): Promise<string[]> {
  const lines: string[] = [];
  for (let start = 1; ; start += LIMITS.maxReadLines) {
    const r = svc.readSource({ sourceId, startLine: start });
    if (!r.ok) break;
    lines.push(...r.value.lines.map((l) => l.text));
    if (r.value.endLine >= r.value.lineCount) break;
  }
  return lines;
}

/** Resolves a folder to its registered project, registering it first when needed. */
async function ensureProject(store: WorkspaceStore, ops: ReturnType<typeof createOperatorService>, target: string): Promise<{ project: Project; registeredNow: boolean } | string> {
  let dirReal: string;
  try {
    dirReal = await realpath(path.resolve(target));
  } catch {
    return `no such folder: ${target}`;
  }
  const known = projectFor(store.listProjects(), dirReal);
  if (known) return { project: known, registeredNow: false };
  const r = await ops.registerProject(dirReal);
  if (!r.ok) return `cannot register ${target}: ${r.error.message}`;
  return { project: r.value.project, registeredNow: !r.value.alreadyRegistered };
}

async function check(t: Term, store: WorkspaceStore, svc: AssistantService, ops: ReturnType<typeof createOperatorService>, target: string, flags: { json: boolean; strict: boolean }): Promise<number> {
  const got = await ensureProject(store, ops, target);
  if (typeof got === "string") return fail(got, 2);
  const { project, registeredNow } = got;
  const projectId = project.id;
  const started = performance.now();
  const scan = flags.json ? await svc.scan({ projectId }) : await withSpinner(t, `Reading agent instructions in ${project.name}…`, () => svc.scan({ projectId }));
  if (!scan.ok) return fail(`${scan.error.code}: ${scan.error.message}`);
  const ms = Math.round(performance.now() - started);
  const sources = svc.listSources({ projectId });
  const findings = svc.listFindings({ projectId });
  const proposals = svc.listProposals({ projectId });
  if (!sources.ok || !findings.ok || !proposals.ok) return fail("could not read the scan results");
  const list = [...findings.value.findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || (a.kind === b.kind ? 0 : a.kind === "structural" ? -1 : 1));
  const errors = list.filter((f) => f.severity === "error").length;
  const code = flags.strict && errors > 0 ? 1 : 0;
  const pending = proposals.value.proposals.filter((p) => p.status === "pending");
  if (flags.json) {
    raw(JSON.stringify({ project: { projectId, name: project.name }, registeredNow, scan: scan.value, sources: sources.value, findings: findings.value, pendingProposals: pending.map((p) => p.proposalId) }, null, 2));
    return code;
  }

  const present = sources.value.sources.filter((s) => s.status === "present");
  if (t.tty) { raw(); for (const l of banner(t)) raw(l); }
  raw();
  raw(render(t, ["  ", ["agent", "◉ "], ["bold", "agentsol check"], "  ", ["muted", tilde(project.rootReal)]]));
  if (registeredNow) raw(render(t, ["  ", ["ok", "✓ "], "Registered ", ["bold", project.name], ["muted", ` (${projectId}) in ${tilde(store.dir)}`]]));
  raw(render(t, ["  ", ["ok", "✓ "], `Read ${n(present.length, "instruction file")}`, ["muted", ` in ${ms} ms · nothing in your project was changed`]]));
  raw();

  raw(`  ${heading(t, "Instruction files", [["muted", `${present.length} read · ${sources.value.notRead.length} not read`]])}`);
  if (present.length === 0) raw(render(t, ["    ", ["muted", "None found. Agentsol looks for AGENTS.md, AGENTS.override.md, CLAUDE.md and SKILL.md."]]));
  const pw = Math.min(44, Math.max(12, ...present.map((s) => s.relPath.length)));
  for (const s of present) raw(render(t, ["    ", ["agent", "▸ "], s.relPath.padEnd(pw), "  ", ["muted", `${String(s.lineCount).padStart(4)} lines`], s.redactedLineCount ? ["warn", `  ${s.redactedLineCount} masked`] : ""]));
  for (const e of sources.value.notRead.slice(0, 8)) raw(render(t, ["    ", ["muted", `○ ${e.relPath.padEnd(pw)}  not read: ${e.reason.replace(/_/g, " ")}`]]));
  if (sources.value.notRead.length > 8) raw(render(t, ["    ", ["muted", `… ${sources.value.notRead.length - 8} more: ${CMD} sources ${projectId}`]]));
  raw();

  const counts = (sev: string): number => list.filter((f) => f.severity === sev).length;
  raw(`  ${heading(t, "Findings", [["bad", `${counts("error")} errors`], ["muted", " · "], ["warn", n(counts("warn"), "warning")], ["muted", " · "], ["info", n(counts("info"), "note")]])}`);
  if (list.length === 0) raw(render(t, ["    ", ["ok", "✓ "], "No structural problems. Your AI can still look for contradictions and vague rules (see below)."]));
  const SHOW = 20;
  for (const f of list.slice(0, SHOW)) {
    const [icon, label] = ICON[f.severity] ?? ICON["info"]!;
    const ev = f.evidence[0];
    const where = ev ? `${ev.relPath}:${ev.startLine}${ev.endLine > ev.startLine ? `-${ev.endLine}` : ""}` : "";
    const kind: Seg = f.kind === "structural" ? ["muted", "fact"] : ["sun", `possible · ${f.confidence} confidence`];
    raw();
    raw(render(t, ["    ", icon, " ", label, "  ", ["bold", f.checkId], "  ", ["agent", where], "  ", kind]));
    for (const l of wrapWords(f.message.split(" "), t.width - 10, " ")) raw(render(t, ["      ", l]));
    if (ev) {
      const r = svc.readSource({ sourceId: ev.sourceId, startLine: ev.startLine, endLine: Math.min(ev.endLine, ev.startLine + 2) });
      if (r.ok) for (const l of r.value.lines) if (l.text.trim()) raw(render(t, ["      ", ["muted", `${String(l.n).padStart(4)} │ `], l.text.length > t.width - 16 ? `${l.text.slice(0, t.width - 17)}…` : l.text]));
    }
  }
  if (list.length > SHOW) raw(render(t, ["\n    ", ["muted", `… ${list.length - SHOW} more: ${CMD} findings ${projectId}`]]));
  if (findings.value.staleHidden > 0) raw(render(t, ["    ", ["muted", `(${n(findings.value.staleHidden, "older finding")} hidden because the files changed)`]]));
  raw();

  const steps: Seg[][] = [
    [["agent", "1 "], "Let your AI go deeper:  ", ["bold", `${CMD} connect`]],
    ["    then ask it: ", ["sun", "“Use agentsol to audit this project.”"]],
    [["agent", "2 "], "Any chat AI, no setup:  ", ["bold", `${CMD} prompt | ${copyCmd()}`], ["muted", "  then paste"]],
  ];
  if (pending.length) steps.push([["agent", "3 "], `${n(pending.length, "proposal")} waiting for you:  `, ["bold", `${CMD} review ${pending[0]?.proposalId ?? ""}`]]);
  for (const l of panel(t, [["bold", "Next"]], steps, Math.min(t.width - 2, 96))) raw(`  ${l}`);
  raw();
  return code;
}

async function promptCmd(store: WorkspaceStore, svc: AssistantService, ops: ReturnType<typeof createOperatorService>, target: string): Promise<number> {
  const got = await ensureProject(store, ops, target);
  if (typeof got === "string") return fail(got, 2);
  const projectId = got.project.id;
  const scan = await svc.scan({ projectId });
  if (!scan.ok) return fail(`${scan.error.code}: ${scan.error.message}`);
  const sources = svc.listSources({ projectId });
  const findings = svc.listFindings({ projectId, kind: "structural" });
  if (!sources.ok || !findings.ok) return fail("could not read the scan results");
  const files = [];
  for (const s of sources.value.sources) if (s.status === "present") files.push({ relPath: s.relPath, lines: await readAll(svc, s.sourceId) });
  const facts = findings.value.findings.map((f: Finding) => `[${f.checkId}] ${f.evidence[0]?.relPath ?? ""}:${f.evidence[0]?.startLine ?? 1} ${f.message}`);
  const text = handoffPrompt(files, facts);
  out(text);
  process.stderr.write(`\nagentsol: prompt ready (${n(files.length, "file")}, ${text.length} characters, secret-like text masked). Paste it into any chat AI; that sends the text to the provider you choose.${process.stdout.isTTY ? ` To copy it: ${CMD} prompt | ${copyCmd()}` : ""}\n`);
  return 0;
}

type ClientSetup = { id: string; name: string; how: string; lines: string[]; note?: string };
function clientSetups(ws: { dir: string; isDefault: boolean }): ClientSetup[] {
  const env = ws.isDefault ? null : path.resolve(ws.dir);
  const npx = `npx ${MCP_ARGS.join(" ")}`;
  const json = (indent = ""): string[] => JSON.stringify({ mcpServers: { agentsol: { command: "npx", args: MCP_ARGS, ...(env ? { env: { AGENTSOL_WORKSPACE: env } } : {}) } } }, null, 2).split("\n").map((l) => indent + l);
  const vs = JSON.stringify({ name: "agentsol", command: "npx", args: MCP_ARGS, ...(env ? { env: { AGENTSOL_WORKSPACE: env } } : {}) });
  const desktop = process.platform === "win32" ? "%APPDATA%\\Claude\\claude_desktop_config.json" : process.platform === "darwin" ? "~/Library/Application Support/Claude/claude_desktop_config.json" : "~/.config/Claude/claude_desktop_config.json";
  return [
    { id: "claude-code", name: "Claude Code", how: "run once:", lines: [`claude mcp add agentsol -s user${env ? ` -e AGENTSOL_WORKSPACE="${env}"` : ""} -- ${npx}`] },
    { id: "codex", name: "Codex (CLI, IDE and ChatGPT desktop share it)", how: "run once:", lines: [`codex mcp add agentsol${env ? ` --env AGENTSOL_WORKSPACE="${env}"` : ""} -- ${npx}`] },
    { id: "gemini", name: "Gemini CLI", how: "run once:", lines: [`gemini mcp add -s user${env ? ` -e AGENTSOL_WORKSPACE="${env}"` : ""} agentsol ${npx}`], note: "Gemini CLI loads MCP servers only in folders you trust. If agentsol shows as disabled, trust the folder when Gemini asks." },
    { id: "vscode", name: "VS Code (Copilot agent mode)", how: "run once:", lines: [`code --add-mcp '${vs}'`] },
    { id: "cursor", name: "Cursor", how: "add to ~/.cursor/mcp.json:", lines: json() },
    { id: "claude-desktop", name: "Claude Desktop", how: `add to ${desktop}:`, lines: json() },
    { id: "windsurf", name: "Windsurf", how: "add to ~/.codeium/windsurf/mcp_config.json:", lines: json() },
  ];
}

function connect(t: Term, ws: { dir: string; isDefault: boolean }, which: string | undefined): number {
  const all = clientSetups(ws);
  const chosen = which ? all.filter((c) => c.id === which) : all;
  if (which && chosen.length === 0) return fail(`unknown client "${which}"; choose one of: ${all.map((c) => c.id).join(", ")}`, 2);
  raw();
  raw(render(t, ["  ", ["agent", "◉ "], ["bold", "Connect agentsol to your AI"], ["muted", "  · runs locally through npx · no account, no API key"]]));
  for (const c of chosen) {
    raw();
    raw(`  ${heading(t, c.name, [["muted", c.how]])}`);
    for (const l of c.lines) raw(render(t, ["    ", ["agent", l]]));
    if (c.note) raw(render(t, ["    ", ["muted", c.note]]));
  }
  raw();
  raw(`  ${heading(t, "Web chats (ChatGPT, Gemini, Claude.ai, Grok…)", [["muted", "they cannot start local servers"]])}`);
  raw(render(t, ["    ", ["agent", `${CMD} prompt | ${copyCmd()}`], ["muted", "  then paste into the chat"]]));
  raw();
  raw(render(t, ["  ", ["sun", "→ "], "Then ask: ", ["sun", "“Use agentsol to audit this project.”"], ["muted", " Clients with MCP prompts also offer "], ["bold", "/audit"], ["muted", "."]]));
  raw(render(t, ["  ", ["muted", "Agentsol never edits your assistant's config itself. Desktop apps that cannot find npx need its full path (which npx)."]]));
  raw();
  return 0;
}

const machine = () => ({ home: homedir(), env: process.env, platform: process.platform });
const flagValue = (args: readonly string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = (args: readonly string[], valued: readonly string[]): string[] => args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
const VERDICT: Record<Verdict, Seg> = { risky: ["bad", "✗ risky "], review: ["warn", "▲ review"], clean: ["ok", "✓ clean "] };
const fmtTokens = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));
const fmtDuration = (ms: number | null): string => {
  if (ms === null) return "?";
  const m = Math.round(ms / 60_000);
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const ago = (iso: string | null): string => {
  if (!iso) return "unknown time";
  const d = Date.now() - Date.parse(iso);
  const h = d / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(d / 60_000))}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
const projectLookup = (store: WorkspaceStore) => {
  const list = store.listProjects();
  return (cwd: string | null) => {
    if (!cwd) return null;
    let real = cwd;
    try { real = realpathSync(cwd); } catch { /* moved or deleted since */ }
    const p = projectFor(list, real);
    return p ? { projectId: p.id, name: p.name } : null;
  };
};

function renderSetup(t: Term, r: SetupReport): void {
  const w = Math.min(t.width - 2, 96);
  raw(`  ${heading(t, "AI setup", [["bad", n(r.summary.errors, "error")], ["muted", " · "], ["warn", n(r.summary.warnings, "warning")], ["muted", " · "], ["info", n(r.summary.notes, "note")]])}`);
  if (r.clients.length === 0) { raw(render(t, ["    ", ["muted", "No assistant settings files found (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Gemini CLI)."]])); raw(); return; }
  raw(render(t, ["    ", ["muted", "Apps   "], r.clients.map((c) => c.client).join(" · ")]));
  const servers = r.servers.filter((s) => !s.disabled);
  raw(render(t, ["    ", ["muted", "MCP    "], `${n(servers.length, "server")}`, ["muted", servers.length ? `  ${[...new Set(servers.map((s) => s.name))].slice(0, 8).join(", ")}` : ""]]));
  for (const i of r.instructions) raw(render(t, ["    ", ["muted", "Rules  "], `${i.file}`, ["muted", `  ~${fmtTokens(i.tokens)} tokens in every ${i.client} session`]]));
  for (const f of r.findings.slice(0, 25)) {
    const [icon, label] = ICON[f.severity] ?? ICON["info"]!;
    raw();
    raw(render(t, ["    ", icon, " ", label, "  ", ["bold", f.checkId], "  ", ["agent", `${f.client}${f.server ? ` · ${f.server}` : ""}`], "  ", ["muted", f.file]]));
    for (const l of wrapWords(f.message.split(" "), w - 8, " ")) raw(render(t, ["      ", l]));
    if (f.excerpt) raw(render(t, ["      ", ["muted", f.excerpt.length > w - 8 ? `${f.excerpt.slice(0, w - 9)}…` : f.excerpt]]));
  }
  if (r.findings.length > 25) raw(render(t, ["\n    ", ["muted", `… ${r.findings.length - 25} more in ${CMD} doctor --json`]]));
  if (r.findings.length === 0) raw(render(t, ["    ", ["ok", "✓ "], "Nothing risky found in these settings."]));
  raw();
  raw(render(t, ["    ", ["muted", "Agentsol only read these files; it changed nothing. Ask your AI to explain them: "], ["sun", "/setup"]]));
  raw();
}

function sessionRow(t: Term, s: SessionSummary, w: number): string {
  const m = s.metrics;
  const where = s.project ? s.project.name : s.cwd ?? "?";
  const counts = s.counts.errors + s.counts.warnings > 0 ? ` · ${s.counts.errors}✗ ${s.counts.warnings}▲` : "";
  return render(t, fit(["    ", VERDICT[s.verdict], "  ", ["bold", s.id.padEnd(21)], ["muted", `${(s.client === "codex" ? "Codex" : "Claude").padEnd(7)}${ago(s.endedAt).padEnd(8)}`], where.length > 22 ? `…${where.slice(-21)}` : where.padEnd(22), ["muted", `  ${m.steps} steps · ${m.filesEdited} edited${m.tokens ? ` · ${fmtTokens(m.tokens.total)} tok` : ""}${counts}`]], w));
}

async function sessionsCmd(t: Term, store: WorkspaceStore, args: readonly string[], json: boolean): Promise<number> {
  const since = parseSince(flagValue(args, "--since"));
  if (!since) return fail("--since must look like 24h, 7d, 2w or a date", 2);
  const limit = Number(flagValue(args, "--limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("--limit must be 1-100", 2);
  const target = positional(args, ["--since", "--limit"])[0];
  let within: string | null = null;
  if (target) {
    try { within = await realpath(path.resolve(target)); } catch { return fail(`no such folder: ${target}`, 2); }
  }
  const r = flagValue(args, "--since") === undefined && !json && t.tty
    ? await withSpinner(t, "Reading recent assistant sessions…", () => listSessions(machine(), { since, limit, project: projectLookup(store), cwdWithin: within }))
    : await listSessions(machine(), { since, limit, project: projectLookup(store), cwdWithin: within });
  if (json) { raw(JSON.stringify(r, null, 2)); return 0; }
  const w = Math.min(t.width - 2, 110);
  raw();
  raw(render(t, ["  ", ["agent", "◉ "], ["bold", "agentsol sessions"], "  ", ["muted", `since ${since.toLocaleDateString()}${within ? ` · in ${tilde(within)}` : ""} · Claude Code and Codex`]]));
  raw();
  if (r.sessions.length === 0) raw(render(t, ["    ", ["muted", "No sessions found. Agentsol reads ~/.claude/projects and ~/.codex/sessions; other assistants do not keep readable transcripts."]]));
  for (const s of r.sessions) raw(sessionRow(t, s, w));
  for (const note of r.notes) raw(render(t, ["    ", ["muted", note]]));
  raw();
  const risky = r.sessions.find((s) => s.verdict !== "clean") ?? r.sessions[0];
  if (risky) {
    for (const l of panel(t, [["bold", "Next"]], [
      [["agent", "1 "], "Open one:  ", ["bold", `${CMD} session ${risky.id}`]],
      [["agent", "2 "], "Have your AI grade them:  ", ["sun", "/review"], ["muted", " or “Use agentsol to review what my agents did this week.”"]],
    ], Math.min(t.width - 2, 96))) raw(`  ${l}`);
    raw();
  }
  return 0;
}

async function sessionCmd(t: Term, store: WorkspaceStore, args: readonly string[], json: boolean): Promise<number> {
  const id = SessionIdSchema.safeParse(positional(args, ["--from"])[0] ?? "");
  if (!id.success) return fail(`session needs an id from ${CMD} sessions, such as claude-1a2b3c4d5e6f`, 2);
  const from = Number(flagValue(args, "--from") ?? 1);
  const r = await reviewSession(machine(), id.data, { fromStep: Number.isInteger(from) && from > 0 ? from : 1, project: projectLookup(store) });
  if (!r.ok) return fail(r.reason === "ambiguous" ? "several sessions start with this id; use the full id" : r.reason === "too_large" ? "this transcript is larger than 64 MB and is not reviewed" : `no session ${id.data}; list them with ${CMD} sessions --since 30d`, 2);
  const v = r.review;
  const grades = store.listSessionGrades(v.id).flatMap((g) => {
    const b = StoredGradeSchema.safeParse(g.body);
    return b.success ? [{ gradeId: g.id, grader: g.grader, createdAt: g.createdAt, overall: overallScore(b.data), body: b.data, label: "assistant judgment" }] : [];
  });
  if (json) { raw(JSON.stringify({ ...v, grades }, null, 2)); return 0; }
  const w = Math.min(t.width - 2, 96);
  const m = v.metrics;
  raw();
  raw(render(t, ["  ", ["agent", "◉ "], ["bold", `session ${v.id}`], "  ", VERDICT[v.verdict], "  ", ["muted", v.client === "codex" ? "Codex" : "Claude Code"]]));
  raw();
  for (const l of panel(t, [["bold", v.project ? v.project.name : v.cwd ?? "unknown folder"]], pairs([
    ["Folder", [v.cwd ?? "unknown"]],
    ["When", [v.startedAt ? localTime(v.startedAt) : "unknown", ["muted", ` · ran ${fmtDuration(m.durationMs)}`]]],
    ["Model", [v.model ?? "unknown"]],
    ["Activity", [`${m.steps} steps · ${m.commands} commands`, m.failedCommands ? ["warn", ` (${m.failedCommands} failed)`] : "", ` · ${m.filesEdited} files edited · ${m.filesRead} read`]],
    ["Also", [`${n(m.userTurns, "message")} from you · ${(m.webFetches === 1 ? "1 web fetch" : `${m.webFetches} web fetches`)} · ${n(m.mcpCalls, "MCP call")}`]],
    ["Tokens", m.tokens ? [`${fmtTokens(m.tokens.total)}`, ["muted", ` (${fmtTokens(m.tokens.input)} in · ${fmtTokens(m.tokens.output)} out)`]] : [["muted", "not recorded"]]],
  ], 12), w)) raw(`  ${l}`);
  raw();
  raw(`  ${heading(t, "Findings", [["bad", n(v.counts.errors, "error")], ["muted", " · "], ["warn", n(v.counts.warnings, "warning")], ["muted", " · "], ["info", n(v.counts.notes, "note")]])}`);
  if (v.findings.length === 0) raw(render(t, ["    ", ["ok", "✓ "], "Nothing flagged by the activity checks."]));
  for (const f of v.findings.slice(0, 40)) {
    const [icon, label] = ICON[f.severity] ?? ICON["info"]!;
    raw();
    raw(render(t, ["    ", icon, " ", label, "  ", ["bold", f.checkId], "  ", f.title, f.step ? ["muted", `  · step ${f.step}`] : ""]));
    for (const l of wrapWords(f.message.split(" "), w - 8, " ")) raw(render(t, ["      ", l]));
    if (f.excerpt) raw(render(t, ["      ", ["agent", f.excerpt.length > w - 8 ? `${f.excerpt.slice(0, w - 9)}…` : f.excerpt]]));
  }
  if (v.findings.length > 40) raw(render(t, ["\n    ", ["muted", `… ${v.findings.length - 40} more in --json`]]));
  raw();
  if (grades.length > 0) {
    raw(`  ${heading(t, "Grades", [["muted", "assistant judgment, shown next to the facts"]])}`);
    for (const g of grades) {
      raw(render(t, ["    ", ["sun", `${g.overall.toFixed(1)}/5`], "  ", ["muted", `${g.grader} · ${localTime(g.createdAt)}`]]));
      raw(render(t, ["      ", ...RUBRIC_KEYS.flatMap((k): Seg[] => [["muted", `${k} `], ["bold", String(g.body.scores[k].score)], "   "])]));
      for (const l of wrapWords(g.body.summary.split(" "), w - 8, " ")) raw(render(t, ["      ", ["muted", l]]));
    }
    raw();
  }
  if (args.includes("--timeline")) {
    raw(`  ${heading(t, "Timeline", [["muted", `steps ${v.timeline.fromStep}-${v.timeline.steps.at(-1)?.n ?? v.timeline.fromStep} of ${r.steps}`]])}`);
    for (const s of v.timeline.steps) {
      raw(render(t, fit(["    ", ["muted", String(s.n).padStart(4)], " ", s.failed ? ["bad", "✗"] : " ", " ", ["agent", s.kind.padEnd(8)], s.target || ["muted", s.tool]], w)));
    }
    if (v.timeline.nextFromStep) raw(render(t, ["    ", ["muted", `more: ${CMD} session ${v.id} --timeline --from ${v.timeline.nextFromStep}`]]));
    raw();
  } else raw(render(t, ["  ", ["muted", `Every step: ${CMD} session ${v.id} --timeline · Grade it with your AI: `], ["sun", "/review"]]));
  for (const note of v.notes) raw(render(t, ["  ", ["muted", note]]));
  raw(render(t, ["  ", ["muted", "Read from the transcript on this machine. Nothing was changed, and nothing was sent anywhere."]]));
  raw();
  return 0;
}

const LESSON_TAG: Record<string, Seg> = { command: ["warn", "command "], correction: ["sun", "you said"], fragile: ["bad", "fragile "], failing: ["info", "needs you"] };

/** Mistakes agents repeated in this project, the time they cost, and the rules that would stop them. */
async function learnCmd(t: Term, store: WorkspaceStore, svc: AssistantService, ops: ReturnType<typeof createOperatorService>, args: readonly string[], json: boolean): Promise<number> {
  const sinceArg = flagValue(args, "--since") ?? "30d";
  if (!parseSince(sinceArg)) return fail("--since must look like 7d, 30d, 12w or a date", 2);
  const got = await ensureProject(store, ops, positional(args, ["--since"])[0] ?? ".");
  if (typeof got === "string") return fail(got, 2);
  const { project } = got;
  const scanned = await svc.scan({ projectId: project.id });
  if (!scanned.ok) return fail(`${scanned.error.code}: ${scanned.error.message}`);
  const work = () => svc.lessons({ projectId: project.id, since: sinceArg });
  const r = !json && t.tty ? await withSpinner(t, "Reading past agent sessions in this project…", work) : await work();
  if (!r.ok) return fail(`${r.error.code}: ${r.error.message}`);
  const L = r.value.projects[0];
  if (!L) return fail("project not found", 2);
  let proposalId: string | null = null;
  if (args.includes("--propose") && L.suggestedChange) {
    const pr = svc.proposeChange({ projectId: project.id, ...L.suggestedChange });
    if (!pr.ok) return fail(`could not propose the change: ${pr.error.message}`);
    proposalId = pr.value.proposalId;
  }
  if (json) { raw(JSON.stringify({ ...L, proposalId, caveats: r.value.caveats, notice: r.value.notice }, null, 2)); return 0; }

  const w = Math.min(t.width - 2, 100);
  const safe = (s: string): string => sanitizeForTerminal(s);
  const fresh = L.lessons.filter((l) => l.rule && !l.alreadyInFile).length;
  const known = L.lessons.filter((l) => l.alreadyInFile).length;
  raw();
  raw(render(t, ["  ", ["sun", "◉ "], ["bold", "agentsol learn  "], ["muted", `${project.name} · since ${new Date(L.since).toLocaleDateString()} · ${n(L.sessionsRead, "session")} read`]]));
  raw();
  if (L.sessionsRead === 0) {
    raw(render(t, ["    ", ["muted", "No Claude Code or Codex sessions ran in this folder in that time. Try a longer window: "], ["bold", `${CMD} learn --since 90d`]]));
    for (const note of L.notes) raw(render(t, ["    ", ["muted", safe(note)]]));
    raw();
    return 0;
  }
  const share = L.agentMs > 0 ? ` (${Math.round((L.lostMs / L.agentMs) * 100)}%)` : "";
  for (const l of panel(t, [["bold", "What repeated mistakes cost"]], pairs([
    ["Time lost", [["bold", fmtDuration(L.lostMs)], ["muted", ` of ${fmtDuration(L.agentMs)} active agent time${share}`]]],
    ["Tokens lost", [["bold", fmtTokens(L.lostTokens)], ["muted", ` of ${fmtTokens(L.agentTokens)} · ${n(L.lostSteps, "wasted step")}`]]],
    ["Lessons", [`${L.lessons.length}`, ["muted", " · "], ["ok", `${n(fresh, "new rule")}`], known ? ["muted", ` · ${known} already in ${L.target?.relPath ?? "the file"} but still repeated`] : ""]],
  ], 14), w)) raw(`  ${l}`);
  raw();
  if (L.lessons.length === 0) raw(render(t, ["    ", ["ok", "✓ "], "No repeated mistakes found. Agents here are not tripping over the same thing twice."]));
  L.lessons.forEach((l, i) => {
    raw(render(t, fit(["  ", ["muted", String(i + 1).padStart(3)], "  ", LESSON_TAG[l.kind] ?? "", "  ", ["muted", `${l.times}× in ${n(l.sessions, "session")}${l.lostMs ? ` · ${fmtDuration(l.lostMs)} lost` : ""}`], l.alreadyInFile ? ["warn", "  · already in the file"] : ""], w)));
    for (const x of wrapWords(safe(l.title).split(" "), w - 9, " ")) raw(render(t, ["         ", x]));
    if (l.rule) for (const [k, x] of wrapWords(safe(l.rule).split(" "), w - 16, " ").entries()) raw(render(t, ["         ", ["ok", k === 0 ? "rule  → " : "        "], ["bold", x]]));
    raw(render(t, fit(["         ", ["muted", `seen in ${l.evidence.map((e) => (e.step ? `${e.sessionId} step ${e.step}` : e.sessionId)).join(" · ")}`]], w)));
    raw();
  });
  for (const note of L.notes) raw(render(t, ["  ", ["warn", "▲ "], ["muted", safe(note)]]));
  if (proposalId) {
    for (const l of panel(t, [["bold", "Proposed"]], [
      [["ok", "✓ "], `${n(fresh, "rule")} added to `, ["bold", L.target?.relPath ?? "the file"], " as a proposal. Nothing is written yet."],
      [["agent", "→ "], "Read it, then approve and apply:  ", ["bold", `${CMD} review ${proposalId}`]],
    ], w)) raw(`  ${l}`);
  } else if (L.suggestedChange) {
    for (const l of panel(t, [["bold", "Next"]], [
      [["agent", "1 "], `Add ${n(fresh, "rule")} to ${L.target?.relPath}:  `, ["bold", `${CMD} learn --propose`]],
      [["agent", "  "], ["muted", "you read the diff, then approve and apply it yourself"]],
      [["agent", "2 "], "Or ask your AI:  ", ["sun", "/learn"], ["muted", "  · run it weekly to see the time it saves"]],
    ], w)) raw(`  ${l}`);
  } else if (L.newFileText) {
    raw(render(t, ["  ", ["warn", "▲ "], "This project has no AGENTS.md or CLAUDE.md. Create AGENTS.md with:"]));
    raw();
    for (const x of L.newFileText.split("\n")) raw(render(t, ["    ", ["agent", safe(x)]]));
  }
  raw();
  raw(render(t, ["  ", ["muted", "Read from transcripts on this machine. Nothing was sent anywhere, and no project file was changed."]]));
  raw();
  return 0;
}

const INSPECT_SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next"]);

/** Reads up to 300 small text files under a folder, never following symlinks. */
function readForInspect(target: string): InspectFile[] {
  const files: InspectFile[] = [];
  const root = path.resolve(target);
  const visit = (p: string): void => {
    if (files.length >= 300) return;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const name of readdirSync(p).sort()) if (!INSPECT_SKIP.has(name)) visit(path.join(p, name)); return; }
    if (!st.isFile() || st.size > 512 * 1024) return;
    const buf = readFileSync(p);
    if (buf.includes(0)) return;
    files.push({ path: path.relative(path.dirname(root), p).split(path.sep).join("/") || path.basename(p), text: buf.toString("utf8") });
  };
  visit(root);
  return files;
}

const INSPECT_VERDICT: Record<InspectReport["verdict"], Seg[]> = {
  danger: [["bad", "✗ Do not install"], ["muted", "  it does things a skill or tool should never do"]],
  caution: [["warn", "▲ Review first"], ["muted", "  some steps need a closer look"]],
  clean: [["ok", "✓ Nothing risky found"], ["muted", "  pattern checks only; still install from sources you trust"]],
};

function inspectCmd(t: Term, target: string | undefined, json: boolean): number {
  if (!target) return fail(`usage: ${CMD} inspect <skill folder | file | tools.json>`, 2);
  if (!existsSync(target)) return fail(`${CMD}: no such file or folder: ${sanitizeForTerminal(target)}`, 2);
  const r = inspectFiles(readForInspect(target), { secretIn });
  if (json) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.verdict === "danger" ? 1 : 0; }
  const w = Math.min(t.width - 2, 96);
  raw();
  raw(render(t, ["  ", ["sun", "◉ "], ["bold", "agentsol inspect  "], ["muted", `${sanitizeForTerminal(target)} · ${r.kind === "mcp" ? "MCP tool list" : r.kind === "skill" ? "skill" : "files"} · ${n(r.scanned, "file")} read`]]));
  raw();
  raw(render(t, ["  ", ...INSPECT_VERDICT[r.verdict]]));
  for (const f of r.findings.slice(0, 40)) {
    raw();
    raw(render(t, fit(["    ", f.severity === "high" ? ["bad", "✗ high  "] : f.severity === "medium" ? ["warn", "▲ medium"] : ["info", "● low   "], "  ", ["agent", sanitizeForTerminal(`${f.path}${f.line ? `:${f.line}` : ""}`)]], w)));
    for (const l of wrapWords(sanitizeForTerminal(f.what).split(" "), w - 8, " ")) raw(render(t, ["      ", l]));
  }
  if (r.findings.length > 40) raw(render(t, ["\n    ", ["muted", `… ${r.findings.length - 40} more in ${CMD} inspect --json`]]));
  raw();
  raw(render(t, ["  ", ["muted", "Read only. Nothing was run, installed or sent anywhere."]]));
  raw();
  return r.verdict === "danger" ? 1 : 0;
}

async function run(argv: string[]): Promise<number> {
  const ws = resolveWorkspace(argv, process.env, homedir());
  const { dir, rest: withFlags } = ws;
  const json = withFlags.includes("--json");
  const strict = withFlags.includes("--strict");
  const rest = withFlags.filter((a) => a !== "--json" && a !== "--strict");
  const term = detectTerm(process.stdout, process.env);
  const [command, ...args] = rest;
  if (command === "--version" || command === "version") {
    out(`agentsol ${PRODUCT_VERSION} (early alpha; approve/apply have not yet been run end to end by a person through this CLI)`);
    return 0;
  }
  if (!command && isInteractive()) {
    home(term, ws);
    return 0;
  }
  if (!command || command === "help" || command === "--help") {
    out(USAGE);
    return command ? 0 : 2;
  }
  if (command === "connect") return connect(term, ws, args[0]);
  if (command === "inspect") return inspectCmd(term, args[0], json);
  if (command === "doctor") {
    // src/cli/main.ts in a checkout, build/cli/main.js in an installed package; both sit two levels below the root.
    const here = fileURLToPath(import.meta.url);
    const install = { kind: here.endsWith(".js") ? "package" : "repo", root: path.resolve(path.dirname(here), "../..") } as const;
    const report = runDoctor({ install, workspace: dir, env: process.env, isTTY: isInteractive() });
    const setup = auditSetup({ ...machine(), projectRoots: [process.cwd()] });
    const setupFailed = strict && setup.summary.errors > 0;
    if (json) process.stdout.write(`${JSON.stringify({ ...report, setup }, null, 2)}\n`);
    else {
      for (const c of report.checks) out(`${c.status.toUpperCase().padEnd(4)}  ${c.message}`);
      if (report.launch) {
        out(`\nCLI:        ${report.launch.cli}`);
        out(`MCP server: ${report.launch.mcp}`);
        out(`MCP client config (example only; Agentsol does not install it):\n${JSON.stringify(report.launch.mcpClientConfig, null, 2)}`);
      }
      out(report.ok ? "\nNo blocking problems found. This does not test any assistant client." : "\nFix the FAIL items above first.");
      raw();
      renderSetup(term, setup);
    }
    return report.ok && !setupFailed ? 0 : 1;
  }
  let store: WorkspaceStore;
  try {
    store = WorkspaceStore.open(dir);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "could not open workspace", 2);
  }
  try {
    const svc = createAssistantService(store, {
      reporter: actor,
      onInternalError: (op, e) => process.stderr.write(`agentsol: ${op} internal error: ${e instanceof Error ? e.message : String(e)}\n`),
    });
    const ops = createOperatorService(store, { actor, homeReal: await realpath(homedir()) });
    const arg = args[0] ?? "";
    switch (command) {
      case "check":
      case "audit":
        return await check(term, store, svc, ops, arg || ".", { json, strict });
      case "prompt":
        return await promptCmd(store, svc, ops, arg || ".");
      case "learn":
        return await learnCmd(term, store, svc, ops, args, json);
      case "sessions":
        return await sessionsCmd(term, store, args, json);
      case "session":
        return await sessionCmd(term, store, args, json);
      case "project": {
        if (args[0] !== "add") return fail("usage: project add <path> [--name <name>]", 2);
        const rest2 = args.slice(1);
        const nameIdx = rest2.indexOf("--name");
        const name = nameIdx >= 0 ? rest2[nameIdx + 1] : undefined;
        const target = rest2.find((a, i) => !a.startsWith("--") && (nameIdx < 0 || i !== nameIdx + 1));
        if (!target) return fail("project add needs a path", 2);
        const r = await ops.registerProject(target, name);
        if (!r.ok) return fail(r.error.message, 2);
        if (r.value.reconfirmed) out(`re-confirmed ${r.value.project.id} ${r.value.project.name}: the folder at this path was replaced, and you confirmed the new one. The next scan reads it.`);
        else if (r.value.alreadyRegistered) out(`already registered: ${r.value.project.id} ${r.value.project.name}`);
        else {
          out(`registered ${r.value.project.id} ${r.value.project.name} (${r.value.project.rootReal})`);
          out("Only AGENTS.md, AGENTS.override.md, CLAUDE.md and SKILL.md files in this folder are read. CLAUDE.local.md, symlinks and secret-like names are skipped.");
        }
        return 0;
      }
      case "projects":
        for (const p of ops.listProjectsWithRoots()) out(`${p.id}  ${p.name}  ${p.rootReal}`);
        return 0;
      case "status":
        return show(await svc.status(), json, (s) => {
          if (s.projects.length === 0) out("No projects registered.");
          for (const p of s.projects) renderStatus(p);
          out("");
          for (const c of s.caveats) out(`note: ${c}`);
        });
      case "scan":
        return show(await svc.scan({ projectId: arg }), json, (v) => out(JSON.stringify(v, null, 2)));
      case "freshness":
        return show(await svc.freshness({ projectId: arg }), json, (v) => {
          out(describeFreshness(v.freshness));
          for (const s of v.sources) out(`  ${s.state.padEnd(18)}  ${s.relPath}`);
          for (const c of v.caveats) out(`note: ${c}`);
        });
      case "sources":
        return show(svc.listSources({ projectId: arg }), json, (v) => {
          for (const s of v.sources) out(`${s.sourceId}  ${s.status.padEnd(7)}  ${s.format.padEnd(18)}  ${s.relPath}${s.redactedLineCount > 0 ? `  (${s.redactedLineCount} redacted line(s))` : ""}`);
          for (const e of v.notRead) out(`not read  ${e.reason.padEnd(22)}  ${e.relPath}`);
        });
      case "findings":
        return show(svc.listFindings({ projectId: arg }), json, (v) => {
          if (v.staleHidden > 0) out(`(${v.staleHidden} finding(s) cite older file versions and are hidden; run scan to refresh)`);
          for (const f of v.findings) {
            const label = f.kind === "structural" ? "FACT" : "POSSIBLE (assistant-reported, unverified)";
            const where = f.evidence.map((e) => `${e.relPath}:${e.startLine}-${e.endLine}`).join(", ");
            out(`${f.id}  ${f.checkId}  ${f.severity.padEnd(5)}  ${label}\n    ${f.title}\n    ${f.message}\n    evidence: ${where}`);
          }
        });
      case "proposals":
        return show(svc.listProposals({ projectId: arg }), json, (v) => {
          for (const p of v.proposals) out(`${p.proposalId}  ${p.status.padEnd(8)}  ${p.relPath}  by ${p.author}${p.baseIsCurrent ? "" : "  (file changed since)"}`);
        });
      case "review": {
        const r = ops.review(arg);
        if (!r.ok) return fail(r.error.message, 2);
        renderReview(r.value);
        return 0;
      }
      case "approve": {
        if (!isProposalId(arg)) return fail("approve needs a proposalId", 2);
        const refused = humanOnly("approve");
        if (refused !== null) return refused;
        const shown = ops.review(arg);
        if (!shown.ok) return fail(shown.error.message, 2);
        renderReview(shown.value);
        const challenge = randomBytes(4).toString("hex");
        const typed = await ask(`\nTo approve exactly this change, type ${challenge} (anything else cancels): `);
        if (typed.trim() !== challenge) return fail("cancelled; nothing was approved", 1);
        const r = ops.approve({ proposalId: arg, reviewedProposalSha256: shown.value.proposal.body.proposalSha256 });
        if (!r.ok) return fail(`not approved: ${r.error.message}`);
        out(`approved (${r.value}); valid for 10 minutes, once. Run: agentsol apply ${arg}`);
        return 0;
      }
      case "reject": {
        if (!isProposalId(arg)) return fail("reject needs a proposalId", 2);
        const refused = humanOnly("reject");
        if (refused !== null) return refused;
        const r = ops.reject(arg);
        if (!r.ok) return fail(r.error.message);
        out("rejected");
        return 0;
      }
      case "apply": {
        if (!isProposalId(arg)) return fail("apply needs a proposalId", 2);
        const refused = humanOnly("apply");
        if (refused !== null) return refused;
        const answer = await ask(`Apply ${arg} to the file on disk? A backup is kept in the workspace. Type "apply" to continue: `);
        if (answer.trim() !== "apply") return fail("cancelled", 1);
        const r = await ops.apply(arg);
        if (!r.ok) return fail(`not applied (${r.error.code}): ${r.error.message}`);
        out(`applied to ${r.value.relPath}; backup at ${r.value.backupPath}${r.value.rescanned ? "" : " (rescan failed; run scan)"}`);
        return 0;
      }
      case "reconcile": {
        if (!isProposalId(arg)) return fail("reconcile needs a proposalId", 2);
        out(`reconcile: ${await ops.reconcile(arg)}`);
        return 0;
      }
      case "audit":
        for (const e of ops.audit(arg || undefined)) out(`${e.at}  ${e.actor}  ${e.action}  ${e.entity_id}  ${e.detail}`);
        return 0;
      default:
        out(USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

process.exitCode = await run(process.argv.slice(2));
