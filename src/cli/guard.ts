/**
 * `agentsol guard`: the hook AI apps run before each shell command. It loads only the guard rules and
 * a lesson cache file (no database), answers in the app's hook format, and fails open: any error,
 * bad input or timeout means no output and exit 0, so the command runs as if the hook were absent.
 */
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeForTerminal } from "../core/display.ts";
import { evaluate, gitBranch, packageManagerFor, type GuardContext, type GuardLesson, type GuardResult } from "../core/guard.ts";
import { resolveWorkspace } from "../core/workspaceArg.ts";

const SELF = fileURLToPath(import.meta.url);
const CACHE = "guard-lessons.json";
const LOCK = "guard-refresh.lock";
const STALE_MS = 30 * 60_000;
const RETRY_MS = 10 * 60_000;
const HOOK_BUDGET_MS = 2_000;

type Workspace = { dir: string; isDefault: boolean };
/** briefing is set only when there is something to tell an agent, so session start stays silent otherwise. */
type Cache = { version: 1; at: string; projects: { root: string; sessionsRead: number; lessons: GuardLesson[]; briefing?: string }[] };
export type HookClient = "claude-code" | "codex" | "gemini" | "cursor" | "copilot" | "cline";

const realOrSelf = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };

function readCache(ws: Workspace): Cache | null {
  try {
    const c = JSON.parse(readFileSync(path.join(ws.dir, CACHE), "utf8")) as Cache;
    return c.version === 1 && Array.isArray(c.projects) ? c : null;
  } catch {
    return null;
  }
}
const projectIn = (cache: Cache | null, cwd: string): Cache["projects"][number] | null => {
  const real = realOrSelf(cwd);
  return cache?.projects.filter((p) => real === p.root || real.startsWith(p.root + path.sep)).sort((a, b) => b.root.length - a.root.length)[0] ?? null;
};
const wsArgs = (ws: Workspace): string[] => (ws.isDefault ? [] : ["--workspace", path.resolve(ws.dir)]);

/** Starts a background refresh of the lesson cache when it is missing or old, at most once per 10 minutes. */
function refreshInBackground(ws: Workspace, cache: Cache | null): void {
  if (!existsSync(ws.dir)) return;
  if (cache && Date.now() - Date.parse(cache.at) < STALE_MS) return;
  const lock = path.join(ws.dir, LOCK);
  if (Date.now() - mtime(lock) < RETRY_MS) return;
  writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  spawn(process.execPath, [SELF, ...wsArgs(ws), "--refresh"], { detached: true, stdio: "ignore", env: process.env }).unref();
}

export function contextFor(cwd: string, home: string, lessons: readonly GuardLesson[]): GuardContext {
  return { lessons, packageManager: packageManagerFor(cwd, home), branch: gitBranch(cwd), home };
}

/** The hook's JSON answer for one app, or null for no output (allow). */
export function hookOutput(client: HookClient, r: GuardResult): string | null {
  if (r.decision === "allow") return null;
  if (client === "gemini") return JSON.stringify(r.decision === "deny" ? { decision: "deny", reason: r.reason } : { systemMessage: r.reason });
  if (client === "cursor") return JSON.stringify({ permission: r.decision, user_message: r.reason, agent_message: r.reason });
  // Codex, Copilot CLI and Cline have no documented "ask", so asking there would be unpredictable.
  if (r.decision === "ask" && (client === "codex" || client === "copilot" || client === "cline")) return null;
  if (client === "copilot") return JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: r.reason });
  if (client === "cline") return JSON.stringify({ cancel: true, errorMessage: r.reason });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: r.decision, permissionDecisionReason: r.reason } });
}

const BRIEFING_MAX = 6_000;
/** The session-start answer that puts the briefing in the agent's context, in each app's format. */
export function briefingOutput(client: HookClient, text: string): string {
  const t = text.length > BRIEFING_MAX ? `${text.slice(0, BRIEFING_MAX)}\n(cut short; call project_briefing for the rest)` : text;
  if (client === "cursor") return JSON.stringify({ additional_context: t });
  if (client === "copilot") return JSON.stringify({ additionalContext: t });
  if (client === "cline") return JSON.stringify({ cancel: false, contextModification: t });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: t } });
}

type HookEvent = { client: HookClient; kind: "start" | "command"; command?: string; cwd?: string };
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const firstRoot = (v: unknown): string | undefined => (Array.isArray(v) ? str(v[0]) : undefined);

/** Which app sent the hook input and what it asks about; null for events the guard ignores. */
export function parseHookEvent(input: string): HookEvent | null {
  const e = JSON.parse(input) as Record<string, unknown>;
  const event = e["hook_event_name"];
  const toolInput = (e["tool_input"] ?? {}) as { command?: unknown };
  if (typeof e["hookName"] === "string") {
    const cwd = firstRoot(e["workspaceRoots"]);
    if (e["hookName"] === "TaskStart") return { client: "cline", kind: "start", cwd };
    const pre = (e["preToolUse"] ?? {}) as { toolName?: unknown; parameters?: { command?: unknown } };
    return e["hookName"] === "PreToolUse" && pre.toolName === "execute_command" ? { client: "cline", kind: "command", command: str(pre.parameters?.command), cwd } : null;
  }
  if (event === "sessionStart") return { client: "cursor", kind: "start", cwd: firstRoot(e["workspace_roots"]) ?? str(e["cwd"]) };
  if (event === "beforeShellExecution") return { client: "cursor", kind: "command", command: str(e["command"]), cwd: str(e["cwd"]) ?? firstRoot(e["workspace_roots"]) };
  if (event === undefined && typeof e["sessionId"] === "string") {
    if (e["toolName"] === undefined) return { client: "copilot", kind: "start", cwd: str(e["cwd"]) };
    if (e["toolName"] !== "bash" && e["toolName"] !== "powershell" && e["toolName"] !== "shell") return null;
    let args: unknown = e["toolArgs"];
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { return null; } }
    return { client: "copilot", kind: "command", command: str((args as { command?: unknown } | null)?.command), cwd: str(e["cwd"]) };
  }
  // Claude Code, Codex and Gemini CLI answer session start the same way.
  if (event === "SessionStart") return { client: "claude-code", kind: "start", cwd: str(e["cwd"]) };
  const client: HookClient = event === "BeforeTool" ? "gemini" : e["turn_id"] !== undefined ? "codex" : "claude-code";
  if (e["tool_name"] !== "Bash" && e["tool_name"] !== "run_shell_command") return null;
  return { client, kind: "command", command: str(toolInput.command), cwd: str(e["cwd"]) };
}

/** Hook mode: one JSON object on stdin from Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI or Cline. */
export function runHook(input: string, env: NodeJS.ProcessEnv, ws: Workspace, home: string): string | null {
  if (env["AGENTSOL_GUARD"] === "off") return null;
  const ev = parseHookEvent(input);
  if (!ev || (ev.kind === "command" && !ev.command)) return null;
  const cwd = ev.cwd && path.isAbsolute(ev.cwd) ? ev.cwd : process.cwd();
  const cache = readCache(ws);
  let out: string | null = null;
  if (ev.kind === "start") {
    const text = projectIn(cache, cwd)?.briefing;
    out = text ? briefingOutput(ev.client, text) : null;
  } else out = hookOutput(ev.client, evaluateHookCommand(ev.command!, cwd, contextFor(cwd, home, projectIn(cache, cwd)?.lessons ?? [])));
  try { refreshInBackground(ws, cache); } catch { /* a read-only or full workspace must not lose the decision */ }
  return out;
}

const MAX_CHECKED = 20_000;
/** Padding a command past the size limit must never get it through unchecked. */
export function evaluateHookCommand(command: string, cwd: string, ctx: GuardContext): GuardResult {
  if (command.length <= MAX_CHECKED) return evaluate(command, cwd, ctx);
  const head = evaluate(command.slice(0, MAX_CHECKED), cwd, ctx);
  if (head.decision !== "allow") return head;
  return { decision: "ask", reason: `Agentsol guard: this command is ${command.length.toLocaleString("en-US")} characters, too long to check. Confirm this is intended.`, rules: ["danger"] };
}

/** Rebuilds the lesson cache from past sessions of every registered project. */
async function refresh(ws: Workspace): Promise<Cache | null> {
  if (!existsSync(ws.dir)) return null;
  const { WorkspaceStore } = await import("../core/store.ts");
  const { createAssistantService } = await import("../core/service/assistant.ts");
  const store = WorkspaceStore.open(ws.dir);
  try {
    const svc = createAssistantService(store, { reporter: () => "agentsol-guard", onInternalError: () => {} });
    const r = await svc.guardLessons();
    if (!r.ok) return null;
    const projects: Cache["projects"] = [];
    for (const { root, projectId, sessionsRead, lessons } of r.value.projects) {
      const b = await svc.briefing({ projectId });
      const worth = b.ok && b.value.follow.length + b.value.outdated.length + b.value.askFirst.length > 0;
      projects.push({ root, sessionsRead, lessons, ...(worth && b.ok ? { briefing: b.value.text } : {}) });
    }
    const cache: Cache = { version: 1, at: new Date().toISOString(), projects };
    const file = path.join(ws.dir, CACHE);
    writeFileSync(`${file}.tmp`, JSON.stringify(cache), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return cache;
  } finally {
    store.close();
  }
}

const USAGE = `agentsol guard                         hook mode: reads the AI app's hook JSON on stdin (set up with: agentsol connect claude-code --guard)
agentsol guard --test "<command>" [--cwd <dir>]
                                       what the guard would say about a command, without running it
agentsol guard --refresh               rebuild the lessons the guard checks against from past sessions`;

export async function guardCli(argv: readonly string[], given?: Workspace): Promise<number> {
  const home = homedir();
  const { rest, ...found } = resolveWorkspace(argv, process.env, home);
  const ws = given ?? found;
  if (rest.includes("--help") || rest.includes("help")) { process.stdout.write(`${USAGE}\n`); return 0; }
  if (rest.includes("--refresh")) return (await refresh(ws)) ? 0 : 1;
  const t = rest.indexOf("--test");
  if (t >= 0) {
    const command = rest[t + 1];
    if (!command) { process.stderr.write(`${USAGE}\n`); return 2; }
    const c = rest.indexOf("--cwd");
    const cwd = path.resolve(c >= 0 ? rest[c + 1] ?? "." : ".");
    let cache = readCache(ws);
    if (!cache || Date.now() - Date.parse(cache.at) >= STALE_MS) cache = (await refresh(ws)) ?? cache;
    const p = projectIn(cache, cwd);
    const ctx = contextFor(cwd, home, p?.lessons ?? []);
    const r = evaluate(command, cwd, ctx);
    const say = (s: string): void => { process.stdout.write(`${sanitizeForTerminal(s)}\n`); };
    say(r.decision === "allow" ? "allow  nothing to stop; the agent runs it without a message" : `${r.decision.padEnd(5)}  ${r.reason.replace(/^Agentsol guard: /, "")}`);
    if (r.fix) say(`       the agent is told to run: ${r.fix}`);
    const pm = ctx.packageManager ? `${ctx.packageManager.pm} (${ctx.packageManager.why})` : "none found";
    say(`\nchecked: package manager ${pm} · ${p ? `${p.lessons.length} lesson${p.lessons.length === 1 ? "" : "s"} from ${p.sessionsRead} past session${p.sessionsRead === 1 ? "" : "s"}` : "no registered project here, so no lessons"} · danger rules`);
    return r.decision === "allow" ? 0 : 1;
  }
  if (process.stdin.isTTY) { process.stderr.write(`${USAGE}\n`); return 2; }
  return hookMain(ws, home);
}

async function hookMain(ws: Workspace, home: string): Promise<number> {
  setTimeout(() => process.exit(0), HOOK_BUDGET_MS).unref();
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const out = runHook(Buffer.concat(chunks).toString("utf8"), process.env, ws, home);
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    // Fail open: a broken hook must never block the agent.
  }
  return 0;
}

// ---------------------------------------------------------------------------------------
// Setup: the command an app runs, and the settings entries that run it

// cmd.exe has no single quotes, and Windows paths cannot contain a double quote.
const shq = (s: string): string => (/^[\w./:=@%+,-]+$/.test(s) ? s : process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`);
/** Absolute node and script paths: npx would resolve the package (and maybe the network) before every command. */
export function guardHookCommand(ws: Workspace): string {
  return `${ws.isDefault ? "" : `AGENTSOL_WORKSPACE=${shq(path.resolve(ws.dir))} `}${shq(process.execPath)} ${shq(SELF)}`;
}
export const runsFromNpxCache = (): boolean => /[\\/]_npx[\\/]/.test(SELF);

type Settings = Record<string, unknown>;
/** One app: where its hooks live (under home) and the entry each event gets. */
export type HookApp = {
  id: HookClient;
  name: string;
  file: string;
  /** The app is on this machine when this folder exists under home. */
  dir: string;
  events: Record<string, Settings>;
  /** Keys a new file needs, such as Cursor's version. */
  base?: Settings;
  /** The file holds only agentsol's hooks, so removing them deletes it. */
  own?: boolean;
  /** Cline runs one executable per event (file is the folder) instead of reading a settings file. */
  scripts?: boolean;
  note?: string;
};

const commandOf = (h: unknown): string | null => {
  const o = h as { command?: unknown; bash?: unknown; powershell?: unknown } | null;
  const c = o?.command ?? o?.bash ?? o?.powershell;
  return typeof c === "string" ? c : null;
};
const isGuard = (h: unknown): boolean => {
  const c = commandOf(h);
  return c !== null && /agentsol/i.test(c) && /[\\/]cli[\\/]guard\.(js|ts)\b/.test(c);
};

/** Every app with hooks: a session-start briefing and a check before each shell command. */
export function hookApps(command: string, platform: NodeJS.Platform = process.platform): HookApp[] {
  const cmd = { type: "command", command, timeout: 5 };
  const copilot = { type: "command", ...(platform === "win32" ? { powershell: `& ${command}` } : { bash: command }), timeoutSec: 5 };
  const noAsk = (app: string): string => `${app} cannot ask yet, so risky commands pass there without a prompt; wrong commands are still blocked.`;
  return [
    { id: "claude-code", name: "Claude Code", file: ".claude/settings.json", dir: ".claude", events: { PreToolUse: { matcher: "Bash", hooks: [cmd] }, SessionStart: { hooks: [cmd] } } },
    { id: "codex", name: "Codex", file: ".codex/hooks.json", dir: ".codex", events: { PreToolUse: { matcher: "Bash", hooks: [cmd] }, SessionStart: { hooks: [cmd] } }, note: noAsk("Codex") },
    { id: "gemini", name: "Gemini CLI", file: ".gemini/settings.json", dir: ".gemini", events: { BeforeTool: { matcher: "run_shell_command", hooks: [{ name: "agentsol-guard", ...cmd, timeout: 5000 }] }, SessionStart: { hooks: [{ name: "agentsol-briefing", ...cmd, timeout: 5000 }] } }, note: "Gemini CLI has no ask: risky commands run, with the warning shown to you." },
    { id: "cursor", name: "Cursor", file: ".cursor/hooks.json", dir: ".cursor", base: { version: 1 }, events: { sessionStart: { command }, beforeShellExecution: { command } } },
    { id: "copilot", name: "Copilot CLI", file: ".copilot/hooks/agentsol.json", dir: ".copilot", base: { version: 1 }, own: true, events: { sessionStart: copilot, preToolUse: copilot }, note: noAsk("Copilot CLI") },
    ...(platform === "win32" ? [] : [{ id: "cline" as const, name: "Cline", file: "Documents/Cline/Hooks", dir: "Documents/Cline", scripts: true, events: { TaskStart: { command }, PreToolUse: { command } }, note: `Turn on Enable Hooks in Cline's settings. ${noAsk("Cline")}` }]),
  ];
}

/** Settings with the app's agentsol hooks added (or removed); every other hook is kept as it was. */
export function withHooks(settings: Settings, app: Pick<HookApp, "events" | "base">, install: boolean): { settings: Settings; changed: boolean } {
  let next = structuredClone(settings);
  const hooks = (next["hooks"] ?? {}) as Record<string, unknown>;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("hooks is not an object");
  for (const [event, entry] of Object.entries(app.events)) {
    const list = hooks[event] ?? [];
    if (!Array.isArray(list)) throw new Error(`hooks.${event} is not a list`);
    const kept: unknown[] = list.flatMap((e: unknown) => {
      if (isGuard(e)) return [];
      const inner = (e as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner) || !inner.some(isGuard)) return [e];
      const others = inner.filter((h) => !isGuard(h));
      return others.length ? [{ ...(e as Settings), hooks: others }] : [];
    });
    if (install) kept.push(entry);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) next["hooks"] = hooks;
  else delete next["hooks"];
  if (install) next = { ...Object.fromEntries(Object.entries(app.base ?? {}).filter(([k]) => !(k in next))), ...next };
  return { settings: next, changed: JSON.stringify(next) !== JSON.stringify(settings) };
}

export type InstallResult = { ok: true; file: string; changed: boolean; backup: string | null } | { ok: false; file: string; message: string };

const SCRIPT_MARK = "# agentsol guard: briefs the agent at task start and checks each shell command";
const scriptText = (command: string): string => `#!/bin/sh\n${SCRIPT_MARK}\n${command}\n`;

function installScripts(home: string, app: HookApp, command: string | null): InstallResult {
  const dir = path.join(home, app.file);
  let changed = false;
  for (const event of Object.keys(app.events)) {
    const file = path.join(dir, event);
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    const ours = current !== null && current.includes(SCRIPT_MARK);
    if (current !== null && !ours) return { ok: false, file, message: `Cline already has a ${event} hook there, so it was left as it is` };
    if (command === null) {
      if (ours) { unlinkSync(file); changed = true; }
      continue;
    }
    const want = scriptText(command);
    if (current === want) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, want, { mode: 0o755 });
    chmodSync(file, 0o755);
    changed = true;
  }
  return { ok: true, file: dir, changed, backup: null };
}

/** Adds (or with command null, removes) the agentsol hooks for one app, after a backup. Call only after the person agreed. */
export function installHooks(home: string, app: HookApp, command: string | null): InstallResult {
  if (app.scripts) return installScripts(home, app, command);
  const file = path.join(home, app.file);
  let current: Settings = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, file, message: "it does not hold a JSON object" };
      current = parsed as Settings;
    } catch {
      return { ok: false, file, message: "it is not valid JSON, so it was left as it is" };
    }
  }
  let next: ReturnType<typeof withHooks>;
  try { next = withHooks(current, app, command !== null); } catch (e) { return { ok: false, file, message: `${e instanceof Error ? e.message : "unexpected shape"}, so it was left as it is` }; }
  if (!next.changed) return { ok: true, file, changed: false, backup: null };
  if (app.own && command === null && !next.settings["hooks"]) { unlinkSync(file); return { ok: true, file, changed: true, backup: null }; }
  // A symlinked settings file (dotfiles repos) is written through to its target so the link survives.
  const target = existsSync(file) ? realpathSync(file) : file;
  let backup: string | null = null;
  if (existsSync(target) && !app.own) {
    backup = `${target}.agentsol-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(target, backup);
  } else mkdirSync(path.dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  writeFileSync(`${target}.agentsol-tmp`, `${JSON.stringify(next.settings, null, 2)}\n`, { mode });
  renameSync(`${target}.agentsol-tmp`, target);
  return { ok: true, file, changed: true, backup };
}

/** Apps on this machine whose agentsol hooks are missing or point at another copy. */
export function appsWithoutHooks(home: string, command: string): HookApp[] {
  return hookApps(command).filter((app) => {
    if (!existsSync(path.join(home, app.dir))) return false;
    if (app.scripts) return Object.keys(app.events).some((e) => { try { return readFileSync(path.join(home, app.file, e), "utf8") !== scriptText(command); } catch { return true; } });
    try { return withHooks(JSON.parse(readFileSync(path.join(home, app.file), "utf8")) as Settings, app, true).changed; } catch { return true; }
  });
}

/** Shell words of a hook command, enough for the commands guardHookCommand writes. */
function shellWords(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : (m[2] ?? m[3] ?? ""));
}
/** Installed guard hooks whose node or script no longer exists (Node upgraded, npx cache cleared, package moved). */
export function brokenGuardHooks(home: string): { client: HookClient; file: string; missing: string }[] {
  const out: { client: HookClient; file: string; missing: string }[] = [];
  const check = (client: HookClient, rel: string, command: string): boolean => {
    const words = shellWords(command.replace(/^& /, "")).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
    const missing = words.slice(0, 2).find((w) => path.isAbsolute(w) && !existsSync(w));
    if (missing) out.push({ client, file: `~/${rel}`, missing });
    return Boolean(missing);
  };
  for (const app of hookApps("")) {
    if (app.scripts) {
      for (const event of Object.keys(app.events)) {
        const rel = `${app.file}/${event}`;
        let text: string;
        try { text = readFileSync(path.join(home, rel), "utf8"); } catch { continue; }
        const line = text.split("\n").find((l) => isGuard({ command: l }));
        if (line && check(app.id, rel, line)) break;
      }
      continue;
    }
    let json: unknown;
    try { json = JSON.parse(readFileSync(path.join(home, app.file), "utf8")); } catch { continue; }
    let found = false;
    const walk = (v: unknown): void => {
      if (found) return;
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (!v || typeof v !== "object") return;
      if (isGuard(v)) { check(app.id, app.file, commandOf(v)!); found = true; return; }
      Object.values(v).forEach(walk);
    };
    walk(json);
  }
  return out;
}

/** Where each app reads hooks, and what to add there by hand. */
export function guardSnippets(command: string): { id: HookClient; name: string; file: string; json: string; note?: string }[] {
  return hookApps(command).map((app) => ({
    id: app.id,
    name: app.name,
    file: `~/${app.file}${app.scripts ? `/{${Object.keys(app.events).join(",")}}` : ""}`,
    json: app.scripts ? scriptText(command).trimEnd() : JSON.stringify({ ...app.base, hooks: Object.fromEntries(Object.entries(app.events).map(([k, v]) => [k, [v]])) }, null, 2),
    ...(app.note ? { note: app.note } : {}),
  }));
}

if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(SELF)) process.exitCode = await guardCli(process.argv.slice(2));
