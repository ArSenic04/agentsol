/**
 * `agentsol guard`: the hook AI apps run before each shell command. It loads only the guard rules and
 * a lesson cache file (no database), answers in the app's hook format, and fails open: any error,
 * bad input or timeout means no output and exit 0, so the command runs as if the hook were absent.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
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
type Cache = { version: 1; at: string; projects: { root: string; sessionsRead: number; lessons: GuardLesson[] }[] };
export type HookClient = "claude-code" | "codex" | "gemini";

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
  // Codex parses "ask" but does not support it yet, so asking there would be unpredictable.
  if (client === "codex" && r.decision === "ask") return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: r.decision, permissionDecisionReason: r.reason } });
}

/** Hook mode: one JSON object on stdin from Claude Code (PreToolUse), Codex (PreToolUse) or Gemini CLI (BeforeTool). */
export function runHook(input: string, env: NodeJS.ProcessEnv, ws: Workspace, home: string): string | null {
  if (env["AGENTSOL_GUARD"] === "off") return null;
  const e = JSON.parse(input) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown; turn_id?: unknown };
  const client: HookClient = e.hook_event_name === "BeforeTool" ? "gemini" : e.turn_id !== undefined ? "codex" : "claude-code";
  if (e.tool_name !== "Bash" && e.tool_name !== "run_shell_command") return null;
  const command = e.tool_input?.command;
  if (typeof command !== "string" || command.length === 0 || command.length > 20_000) return null;
  const cwd = typeof e.cwd === "string" && path.isAbsolute(e.cwd) ? e.cwd : process.cwd();
  const cache = readCache(ws);
  refreshInBackground(ws, cache);
  return hookOutput(client, evaluate(command, cwd, contextFor(cwd, home, projectIn(cache, cwd)?.lessons ?? [])));
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
    const cache: Cache = { version: 1, at: new Date().toISOString(), projects: r.value.projects.map(({ root, sessionsRead, lessons }) => ({ root, sessionsRead, lessons })) };
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

const shq = (s: string): string => (/^[\w./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
/** Absolute node and script paths: npx would resolve the package (and maybe the network) before every command. */
export function guardHookCommand(ws: Workspace): string {
  return `${ws.isDefault ? "" : `AGENTSOL_WORKSPACE=${shq(path.resolve(ws.dir))} `}${shq(process.execPath)} ${shq(SELF)}`;
}
export const runsFromNpxCache = (): boolean => /[\\/]_npx[\\/]/.test(SELF);
const isGuard = (h: unknown): boolean => typeof (h as { command?: unknown })?.command === "string" && /agentsol/i.test((h as { command: string }).command) && /[\\/]cli[\\/]guard\.(js|ts)\b/.test((h as { command: string }).command);

type Settings = Record<string, unknown>;
/** Settings with the guard hook set to command (or removed when null); every other hook is kept as it was. */
export function withGuardHook(settings: Settings, command: string | null): { settings: Settings; changed: boolean } {
  const next = structuredClone(settings);
  const hooks = (next["hooks"] ?? {}) as Record<string, unknown>;
  if (typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("hooks is not an object");
  const pre = hooks["PreToolUse"] ?? [];
  if (!Array.isArray(pre)) throw new Error("hooks.PreToolUse is not a list");
  const kept: unknown[] = pre.flatMap((entry: { hooks?: unknown }) => {
    if (!Array.isArray(entry?.hooks) || !entry.hooks.some(isGuard)) return [entry];
    const others = entry.hooks.filter((h) => !isGuard(h));
    return others.length ? [{ ...entry, hooks: others }] : [];
  });
  if (command) kept.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] });
  if (kept.length) hooks["PreToolUse"] = kept;
  else delete hooks["PreToolUse"];
  if (Object.keys(hooks).length) next["hooks"] = hooks;
  else delete next["hooks"];
  return { settings: next, changed: JSON.stringify(next) !== JSON.stringify(settings) };
}

export type InstallResult = { ok: true; file: string; changed: boolean; backup: string | null } | { ok: false; file: string; message: string };
/** Adds (or with command null, removes) the guard hook in <home>/.claude/settings.json, after a backup. Call only after the person agreed. */
export function installClaudeGuard(home: string, command: string | null): InstallResult {
  const file = path.join(home, ".claude", "settings.json");
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
  let next: ReturnType<typeof withGuardHook>;
  try { next = withGuardHook(current, command); } catch (e) { return { ok: false, file, message: `${e instanceof Error ? e.message : "unexpected shape"}, so it was left as it is` }; }
  if (!next.changed) return { ok: true, file, changed: false, backup: null };
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.agentsol-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  } else mkdirSync(path.dirname(file), { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(`${file}.agentsol-tmp`, `${JSON.stringify(next.settings, null, 2)}\n`, { mode });
  renameSync(`${file}.agentsol-tmp`, file);
  return { ok: true, file, changed: true, backup };
}

/** Where each app reads hooks, and the entry to add there by hand. */
export function guardSnippets(command: string): { id: HookClient; name: string; file: string; json: string; note?: string }[] {
  const entry = { type: "command", command, timeout: 5 };
  return [
    { id: "claude-code", name: "Claude Code", file: "~/.claude/settings.json", json: JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [entry] }] } }, null, 2) },
    { id: "codex", name: "Codex", file: "~/.codex/hooks.json", json: JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [entry] }] } }, null, 2), note: "Codex blocks wrong commands but does not support asking yet, so risky commands pass there without a prompt." },
    { id: "gemini", name: "Gemini CLI", file: "~/.gemini/settings.json", json: JSON.stringify({ hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ name: "agentsol-guard", ...entry, timeout: 5000 }] }] } }, null, 2), note: "Gemini CLI has no ask: risky commands run, with the warning shown to you." },
  ];
}

if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(SELF)) process.exitCode = await guardCli(process.argv.slice(2));
