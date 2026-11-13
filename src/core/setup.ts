/**
 * AI setup audit: reads the MCP, permission and hook settings of assistant apps on this
 * machine (user level, plus project-level files in the folders given) and reports risky
 * entries. Read-only. Secret values never leave this module: only key names and the kind
 * of secret do. File paths are shown relative to the home folder.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { redactLines, secretKinds, secretLabel, type SecretKind } from "./secrets.ts";


export const SETUP_CHECKS = {
  C01: "Secret saved in plain text in an AI app's settings",
  C02: "MCP server runs whatever version was published last",
  C03: "Remote MCP server over unencrypted http",
  C04: "MCP server starts through a shell or a download-and-run command",
  C05: "MCP server command not found",
  C06: "Assistant may act without asking you",
  C07: "Hooks run commands automatically",
  C08: "A project folder adds its own MCP servers",
  C09: "Global instructions add tokens to every session",
  C10: "Settings file could not be read",
} as const;
export type SetupCheckId = keyof typeof SETUP_CHECKS;
export type Severity = "error" | "warn" | "info";

export type SetupFinding = {
  checkId: SetupCheckId; severity: Severity; title: string; client: string; file: string;
  server: string | null; message: string; excerpt: string | null;
};
export type McpServerInfo = {
  client: string; file: string; scope: "user" | "project" | "local"; name: string;
  transport: "stdio" | "http"; launch: string; envKeys: string[]; disabled: boolean;
};
export type InstructionWeight = { client: string; file: string; bytes: number; tokens: number };
export type SetupReport = {
  checkedAt: string;
  clients: { client: string; files: string[] }[];
  servers: McpServerInfo[];
  instructions: InstructionWeight[];
  findings: SetupFinding[];
  summary: { errors: number; warnings: number; notes: number };
  caveats: string[];
};
export type SetupContext = {
  home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform;
  /** Project folders whose own MCP and permission files are checked too. */
  projectRoots: readonly string[];
  commandExists?: (command: string) => boolean;
};

export const SETUP_CAVEATS = [
  "Only the settings files listed under clients were read. Managed, enterprise, workspace and extension-specific settings are not checked.",
  "Secret detection is pattern-based. A finding shows the setting name and the kind of secret, never the value.",
  "Token counts are estimates (about 4 characters per token), not a tokenizer.",
];

const MAX_SETTINGS_BYTES = 32 * 1024 * 1024;
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function displayPath(abs: string, home: string): string {
  if (abs === home) return "~";
  return abs.startsWith(`${home}${path.sep}`) ? `~${path.sep}${abs.slice(home.length + 1)}` : abs;
}

/** Masks secrets, shortens the home folder and caps the length of a command line or URL. */
export function maskLaunch(text: string, home: string, max = 160): string {
  const masked = (redactLines([text]).lines[0] ?? "").split(home).join("~");
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

// ---------------------------------------------------------------------------------------
// Parsers: JSON with comments (VS Code style) and the subset of TOML that Codex uses.

/** JSON that may contain // and /* comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  const strip = (s: string, drop: (i: number) => number): string => {
    let out = "";
    let inStr = false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i] ?? "";
      if (inStr) {
        out += c;
        if (c === "\\") { out += s[i + 1] ?? ""; i += 1; } else if (c === "\"") inStr = false;
        continue;
      }
      if (c === "\"") { inStr = true; out += c; continue; }
      const skip = drop(i);
      if (skip > 0) { i += skip - 1; continue; }
      out += c;
    }
    return out;
  };
  const noComments = strip(text.replace(/^﻿/, ""), (i) => {
    if (text[i] === "/" && text[i + 1] === "/") { const end = text.indexOf("\n", i); return (end < 0 ? text.length : end) - i; }
    if (text[i] === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); return (end < 0 ? text.length : end + 2) - i; }
    return 0;
  });
  const noTrailing = strip(noComments, (i) => (noComments[i] === "," && /^\s*[}\]]/.test(noComments.slice(i + 1, i + 200)) ? 1 : 0));
  return JSON.parse(noTrailing);
}

class TomlValueParser {
  private i = 0;
  private readonly s: string;
  constructor(s: string) { this.s = s; }
  private ws(): void { while (/\s/.test(this.s[this.i] ?? "")) this.i += 1; }
  parse(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (this.s.startsWith("\"\"\"", this.i)) return this.multi("\"\"\"");
    if (this.s.startsWith("'''", this.i)) return this.multi("'''");
    if (c === "\"") return this.basic();
    if (c === "'") { const end = this.s.indexOf("'", this.i + 1); if (end < 0) throw new Error("toml"); const v = this.s.slice(this.i + 1, end); this.i = end + 1; return v; }
    if (c === "[") return this.array();
    if (c === "{") return this.table();
    const m = /^(true|false|[+-]?[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)/.exec(this.s.slice(this.i));
    if (!m) throw new Error("toml");
    this.i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : Number(m[0].replace(/_/g, ""));
  }
  private multi(q: string): string {
    const end = this.s.indexOf(q, this.i + 3);
    if (end < 0) throw new Error("toml");
    const v = this.s.slice(this.i + 3, end).replace(/^\r?\n/, "");
    this.i = end + 3;
    return v;
  }
  private basic(): string {
    let out = "";
    for (this.i += 1; this.i < this.s.length; this.i += 1) {
      const c = this.s[this.i] ?? "";
      if (c === "\"") { this.i += 1; return out; }
      if (c !== "\\") { out += c; continue; }
      const e = this.s[++this.i] ?? "";
      if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        out += String.fromCodePoint(Number.parseInt(this.s.slice(this.i + 1, this.i + 1 + len), 16) || 0xfffd);
        this.i += len;
      } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
    }
    throw new Error("toml");
  }
  private array(): unknown[] {
    const out: unknown[] = [];
    this.i += 1;
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") { this.i += 1; return out; }
      out.push(this.parse());
      this.ws();
      if (this.s[this.i] === ",") this.i += 1;
      else if (this.s[this.i] !== "]") throw new Error("toml");
    }
  }
  private table(): Rec {
    const out: Rec = {};
    this.i += 1;
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") { this.i += 1; return out; }
      const eq = topLevelIndex(this.s, "=", this.i);
      if (eq < 0) throw new Error("toml");
      const keys = keyPath(this.s.slice(this.i, eq));
      this.i = eq + 1;
      setPath(out, keys, this.parse());
      this.ws();
      if (this.s[this.i] === ",") this.i += 1;
    }
  }
}

/** Index of `ch` at or after `from` that is not inside a quoted string. */
function topLevelIndex(s: string, ch: string, from = 0): number {
  let q: string | null = null;
  for (let i = from; i < s.length; i += 1) {
    const c = s[i];
    if (q) { if (c === "\\" && q === "\"") i += 1; else if (c === q) q = null; continue; }
    if (c === "\"" || c === "'") q = c;
    else if (c === ch) return i;
  }
  return -1;
}

function keyPath(raw: string): string[] {
  const keys: string[] = [];
  let rest = raw.trim();
  while (rest) {
    const dot = topLevelIndex(rest, ".");
    const part = (dot < 0 ? rest : rest.slice(0, dot)).trim();
    keys.push(/^(["']).*\1$/.test(part) ? part.slice(1, -1) : part);
    rest = dot < 0 ? "" : rest.slice(dot + 1);
  }
  return keys;
}

function setPath(root: Rec, keys: readonly string[], value: unknown): void {
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) { cur[k] = value; return; }
    const next = rec(cur[k]) ?? {};
    cur[k] = next;
    cur = next;
  });
}

const bracketDepth = (s: string): number => {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) { if (c === "\\" && q === "\"") i += 1; else if (c === q) q = null; continue; }
    if (c === "#") break;
    if (c === "\"" || c === "'") q = c;
    else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
  }
  return depth;
};

/** Tables, dotted keys, strings, numbers, booleans, arrays and inline tables. Arrays of tables are skipped. */
export function parseTomlSubset(text: string): Rec {
  const root: Rec = {};
  let cur: Rec | null = root;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[")) { cur = null; continue; }
    if (line.startsWith("[")) {
      const end = topLevelIndex(line, "]", 1);
      const keys = keyPath(line.slice(1, end < 0 ? undefined : end));
      let t = root;
      for (const k of keys) { const next = rec(t[k]) ?? {}; t[k] = next; t = next; }
      cur = t;
      continue;
    }
    const eq = topLevelIndex(line, "=");
    if (eq < 0) continue;
    let rhs = line.slice(eq + 1).trim();
    const tripleOpen = (q: string): boolean => rhs.startsWith(q) && rhs.indexOf(q, 3) < 0;
    while ((tripleOpen("\"\"\"") || tripleOpen("'''")) && i + 1 < lines.length) rhs += `\n${lines[++i] ?? ""}`;
    while (bracketDepth(rhs) > 0 && i + 1 < lines.length) rhs += `\n${lines[++i] ?? ""}`;
    if (!cur) continue;
    try {
      setPath(cur, keyPath(line.slice(0, eq)), new TomlValueParser(rhs).parse());
    } catch {
      // Values this subset does not understand (dates, odd escapes) are skipped.
    }
  }
  return root;
}

// ---------------------------------------------------------------------------------------
// Checks

const REFERENCE = /\$\{[^}]+\}|^\$[A-Za-z_][A-Za-z0-9_]*$|^\{\{.*\}\}$|^(op|vault|keychain|env|secret):/i;
const PLACEHOLDER = /^<.*>$|^\[.*\]$|your[_-]|_here$|^x{4,}$|changeme|placeholder|example|^\*+$|^(true|false|null|none|\d+)$/i;
const SECRET_KEY = /(^|[_.-])(api[_-]?key|key|token|secret|password|passwd|pat|credentials?|auth|bearer|private[_-]?key)([_.-]|$)/i;

/** Returns the kind of secret a literal setting value looks like, or null for references, placeholders and plain values. */
export function literalSecretKind(key: string, value: string): SecretKind | null {
  const v = value.trim();
  if (!v || REFERENCE.test(v) || PLACEHOLDER.test(v)) return null;
  const hit = redactLines([v]).redacted[0];
  if (hit) return hit.real[0] ?? null;
  return SECRET_KEY.test(key) && v.length >= 8 && !/\s/.test(v) && !/^(https?:)?\/\//.test(v) && !path.isAbsolute(v) ? "assignment" : null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "powershell", "pwsh"]);
const DOWNLOAD_RUN = /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|iex)\b/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
const DOCKER_VALUE_FLAGS = new Set(["-e", "--env", "-v", "--volume", "--name", "-p", "--publish", "--network", "--mount", "-w", "--workdir", "-u", "--user", "--entrypoint", "--platform", "--env-file", "-l", "--label"]);

const cmdName = (command: string): string => path.basename(command).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();

/** The package a runner (npx, bunx, pnpm dlx, uvx, pipx run, docker run) starts, or null. */
export function runnerPackage(command: string, args: readonly string[]): { runner: string; spec: string } | null {
  const name = cmdName(command);
  const firstPlain = (from: number, valued: ReadonlySet<string> = new Set()): string | null => {
    for (let i = from; i < args.length; i += 1) {
      const a = args[i] ?? "";
      if (a === "--") return args[i + 1] ?? null;
      if (a.startsWith("-")) { if (valued.has(a)) i += 1; continue; }
      return a;
    }
    return null;
  };
  let spec: string | null = null;
  if (name === "npx" || name === "bunx") {
    const p = args.findIndex((a) => a === "-p" || a === "--package");
    const eq = args.find((a) => a.startsWith("--package="));
    spec = p >= 0 ? args[p + 1] ?? null : eq ? eq.slice("--package=".length) : firstPlain(0);
  } else if ((name === "pnpm" || name === "yarn") && args[0] === "dlx") spec = firstPlain(1);
  else if (name === "uvx") {
    const from = args.indexOf("--from");
    spec = from >= 0 ? args[from + 1] ?? null : firstPlain(0, new Set(["--with", "--python", "-p"]));
  } else if (name === "pipx" && args[0] === "run") spec = firstPlain(1, new Set(["--spec"]));
  else if ((name === "docker" || name === "podman") && args.includes("run")) spec = firstPlain(args.indexOf("run") + 1, DOCKER_VALUE_FLAGS);
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~") || /^[a-z]+:/i.test(spec) && !spec.startsWith("@")) return null;
  return { runner: name, spec };
}

export function isPinned(runner: string, spec: string): boolean {
  if (runner === "docker" || runner === "podman") {
    if (spec.includes("@sha256:")) return true;
    const tag = /:([^/:]+)$/.exec(spec)?.[1];
    return Boolean(tag && tag !== "latest");
  }
  if (runner === "uvx" || runner === "pipx") return /==\s*\d|@\d/.test(spec);
  const at = spec.lastIndexOf("@");
  return at > 0 && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(spec.slice(at + 1));
}

function defaultCommandExists(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): (command: string) => boolean {
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? ["", ...(env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  return (command) => dirs.some((d) => exts.some((x) => existsSync(path.join(d, command + x))));
}

type Ctx = SetupContext & { findings: SetupFinding[]; servers: McpServerInfo[]; exists: (c: string) => boolean };

function add(ctx: Ctx, checkId: SetupCheckId, severity: Severity, client: string, file: string, server: string | null, message: string, excerpt: string | null = null): void {
  ctx.findings.push({ checkId, severity, title: SETUP_CHECKS[checkId], client, file, server, message, excerpt });
}

function secretsIn(ctx: Ctx, client: string, file: string, server: string | null, where: string, values: Rec | null): void {
  for (const [k, v] of Object.entries(values ?? {})) {
    const s = str(v);
    const kind = s === null ? null : literalSecretKind(k, s);
    if (kind) add(ctx, "C01", "error", client, file, server, `${where}.${k} holds ${secretLabel(kind)} in plain text. Anyone or anything that can read this file can use it. Move it to an environment variable or the app's secret input and rotate it.`, `${where}.${k} = [REDACTED:${kind}]`);
  }
}

function auditServer(ctx: Ctx, client: string, file: string, scope: McpServerInfo["scope"], name: string, raw: unknown): void {
  const e = rec(raw);
  if (!e) return;
  const url = str(e["url"]) ?? str(e["serverUrl"]) ?? str(e["httpUrl"]);
  const command = str(e["command"]);
  const args = strs(e["args"]);
  const env = rec(e["env"]);
  const disabled = e["disabled"] === true || e["enabled"] === false;
  const launch = url ? maskLaunch(url.replace(/[?#].*$/, ""), ctx.home) : maskLaunch([command ?? "", ...args].join(" ").trim(), ctx.home);
  ctx.servers.push({ client, file, scope, name, transport: url ? "http" : "stdio", launch, envKeys: Object.keys(env ?? {}).sort(), disabled });

  secretsIn(ctx, client, file, name, "env", env);
  secretsIn(ctx, client, file, name, "headers", rec(e["headers"]) ?? rec(e["http_headers"]));
  const bearer = str(e["bearer_token"]);
  if (bearer && literalSecretKind("bearer_token", bearer)) add(ctx, "C01", "error", client, file, name, "bearer_token holds a token in plain text. Use bearer_token_env_var instead and rotate the token.", "bearer_token = [REDACTED:bearer]");
  args.forEach((a, i) => {
    const flag = /^--?(api[-_]?key|token|secret|password|access[-_]?key|auth)$/i.test(a);
    const next = args[i + 1];
    const kind = flag && next ? literalSecretKind("token", next) : secretKinds(a)[0] ?? null;
    if (kind) add(ctx, "C01", "error", client, file, name, `An argument holds ${secretLabel(kind)} in plain text, and process lists show arguments to other programs. Pass it through an environment variable instead and rotate it.`, `args[${flag ? i + 1 : i}] = [REDACTED:${kind}]`);
  });
  if (url && secretKinds(url).length > 0) add(ctx, "C01", "error", client, file, name, "The server URL contains a credential. Send it as a header from an environment variable instead and rotate it.", maskLaunch(url, ctx.home));

  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname)) add(ctx, "C03", "warn", client, file, name, `Connects to ${u.hostname} without encryption, so anyone on the network path can read or change the traffic. Use https.`, launch);
    } catch {
      // Not a URL Node can parse; nothing to check.
    }
    return;
  }
  if (!command) return;
  const joined = [command, ...args].join(" ");
  if (DOWNLOAD_RUN.test(joined)) add(ctx, "C04", "warn", client, file, name, "Downloads a script and runs it at every start. Whoever controls that URL controls what runs on your machine.", launch);
  else if (SHELLS.has(cmdName(command)) && args.some((a) => /^(-c|-lc|\/c|-command)$/i.test(a))) add(ctx, "C04", "warn", client, file, name, "Starts through a shell with the real command inside a string, which hides what actually runs. Call the program directly.", launch);
  const pkg = runnerPackage(command, args);
  if (pkg && !isPinned(pkg.runner, pkg.spec)) add(ctx, "C02", "info", client, file, name, `Runs ${pkg.spec} through ${pkg.runner} without an exact version, so each start runs whatever was published last. Pin a version if you want to choose when it updates.`, launch);
  if (!disabled) {
    const missing = path.isAbsolute(command) ? !existsSync(command) : !command.includes("/") && !command.includes("\\") && !ctx.exists(command);
    if (missing) add(ctx, "C05", "warn", client, file, name, path.isAbsolute(command) ? "The command path does not exist, so this server fails to start." : `${command} is not on this terminal's PATH. The server fails to start unless the app sees a different PATH; desktop apps often need the full path (which ${command}).`, launch);
  }
}

function auditServers(ctx: Ctx, client: string, file: string, scope: McpServerInfo["scope"], servers: unknown): number {
  const map = rec(servers);
  if (!map) return 0;
  for (const [name, entry] of Object.entries(map)) auditServer(ctx, client, file, scope, name, entry);
  return Object.keys(map).length;
}

const RISKY_ALLOW = /^Bash(\((\*|:\*|rm[ :].*|sudo[ :].*|curl[ :].*|wget[ :].*|git push[ :].*|chmod[ :].*|ssh[ :].*|scp[ :].*)\))?$/;

function auditClaudeSettings(ctx: Ctx, file: string, s: Rec): void {
  const client = "Claude Code";
  const perms = rec(s["permissions"]);
  if (str(perms?.["defaultMode"]) === "bypassPermissions") add(ctx, "C06", "warn", client, file, null, "Claude Code runs every tool without asking (permissions.defaultMode is bypassPermissions).", "permissions.defaultMode = bypassPermissions");
  const risky = strs(perms?.["allow"]).filter((r) => RISKY_ALLOW.test(r.trim()));
  if (risky.length > 0) add(ctx, "C06", "warn", client, file, null, `Claude Code may run ${risky.some((r) => /^Bash(\((\*|:\*)\))?$/.test(r)) ? "any shell command" : "risky shell commands"} without asking.`, `permissions.allow: ${risky.slice(0, 5).join(", ")}`);
  if (s["enableAllProjectMcpServers"] === true) add(ctx, "C06", "warn", client, file, null, "Every MCP server that a project's .mcp.json lists is approved automatically, including in repositories you just cloned.", "enableAllProjectMcpServers = true");
  secretsIn(ctx, client, file, null, "env", rec(s["env"]));
  const hooks = rec(s["hooks"]);
  if (!hooks) return;
  const commands: { event: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) for (const h of Array.isArray(rec(g)?.["hooks"]) ? (rec(g)?.["hooks"] as unknown[]) : []) {
      const c = str(rec(h)?.["command"]);
      if (c) commands.push({ event, command: c });
    }
  }
  if (commands.length === 0) return;
  const net = commands.find((c) => /\b(curl|wget|nc|ncat|scp|rsync|ssh)\b|https?:\/\//.test(c.command));
  if (net) add(ctx, "C07", "warn", client, file, null, `A ${net.event} hook can send data over the network every time it fires. Check that you trust where it goes.`, maskLaunch(net.command, ctx.home));
  else add(ctx, "C07", "info", client, file, null, `${commands.length} hook command${commands.length === 1 ? "" : "s"} run automatically on: ${[...new Set(commands.map((c) => c.event))].join(", ")}.`, null);
}

function auditCodex(ctx: Ctx, file: string, t: Rec, scope: McpServerInfo["scope"]): number {
  const client = "Codex";
  const policies: [string, Rec][] = [["", t], ...Object.entries(rec(t["profiles"]) ?? {}).flatMap(([n, p]): [string, Rec][] => (rec(p) ? [[`profiles.${n}.`, rec(p)!]] : []))];
  for (const [prefix, p] of policies) {
    const never = str(p["approval_policy"]) === "never";
    const open = str(p["sandbox_mode"]) === "danger-full-access";
    if (never && open) add(ctx, "C06", "error", client, file, null, "Codex runs any command, without a sandbox, and never asks first.", `${prefix}approval_policy = never, ${prefix}sandbox_mode = danger-full-access`);
    else if (never) add(ctx, "C06", "warn", client, file, null, "Codex never asks before running commands. The sandbox is the only limit.", `${prefix}approval_policy = never`);
    else if (open) add(ctx, "C06", "warn", client, file, null, "Codex runs commands without a sandbox, with full access to your files and network.", `${prefix}sandbox_mode = danger-full-access`);
  }
  return auditServers(ctx, client, file, scope, t["mcp_servers"]);
}

type Loaded = { ok: true; data: unknown } | { ok: false } | null;
function load(abs: string, format: "json" | "toml"): Loaded {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > MAX_SETTINGS_BYTES) return { ok: false };
    const text = readFileSync(abs, "utf8");
    return { ok: true, data: format === "toml" ? parseTomlSubset(text) : parseJsonc(text) };
  } catch (e) {
    return e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "ENOTDIR") ? null : { ok: false };
  }
}

/** Audits every known assistant settings file on this machine. Synchronous and read-only. */
export function auditSetup(context: SetupContext): SetupReport {
  const { home, env, platform } = context;
  const ctx: Ctx = { ...context, findings: [], servers: [], exists: context.commandExists ?? defaultCommandExists(env, platform) };
  const clients = new Map<string, string[]>();
  const appData = env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
  const appSupport = platform === "darwin" ? path.join(home, "Library", "Application Support") : platform === "win32" ? appData : env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
  const claudeDir = env["CLAUDE_CONFIG_DIR"] ?? path.join(home, ".claude");
  const claudeState = env["CLAUDE_CONFIG_DIR"] ? path.join(env["CLAUDE_CONFIG_DIR"], ".claude.json") : path.join(home, ".claude.json");
  const codexHome = env["CODEX_HOME"] ?? path.join(home, ".codex");
  const geminiDir = path.join(home, ".gemini");

  const visit = (client: string, abs: string, format: "json" | "toml", fn: (data: Rec, file: string) => void): void => {
    const r = load(abs, format);
    if (!r) return;
    const file = displayPath(abs, home);
    (clients.get(client) ?? clients.set(client, []).get(client)!).push(file);
    const data = r.ok ? rec(r.data) : null;
    if (!data) { add(ctx, "C10", "info", client, file, null, "This settings file exists but could not be parsed, so it was not checked."); return; }
    fn(data, file);
  };
  const mcpFile = (client: string, abs: string, key: string, scope: "user" | "project"): void =>
    visit(client, abs, "json", (d, file) => {
      const n = auditServers(ctx, client, file, scope, d[key]);
      if (scope === "project" && n > 0) add(ctx, "C08", "info", client, file, null, `This folder adds ${n} MCP server${n === 1 ? "" : "s"} (${Object.keys(rec(d[key]) ?? {}).slice(0, 6).join(", ")}). Assistants may offer to start them when the folder is opened; check them before you trust it.`);
    });

  mcpFile("Claude Desktop", path.join(appSupport, "Claude", "claude_desktop_config.json"), "mcpServers", "user");
  visit("Claude Code", claudeState, "json", (d, file) => {
    auditServers(ctx, "Claude Code", file, "user", d["mcpServers"]);
    for (const [proj, p] of Object.entries(rec(d["projects"]) ?? {})) auditServers(ctx, "Claude Code", `${file} (project ${displayPath(proj, home)})`, "local", rec(p)?.["mcpServers"]);
  });
  visit("Claude Code", path.join(claudeDir, "settings.json"), "json", (d, file) => auditClaudeSettings(ctx, file, d));
  mcpFile("Cursor", path.join(home, ".cursor", "mcp.json"), "mcpServers", "user");
  mcpFile("Windsurf", path.join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers", "user");
  mcpFile("VS Code", path.join(appSupport, "Code", "User", "mcp.json"), "servers", "user");
  visit("VS Code", path.join(appSupport, "Code", "User", "settings.json"), "json", (d, file) => {
    auditServers(ctx, "VS Code", file, "user", rec(d["mcp"])?.["servers"]);
    const key = ["chat.tools.global.autoApprove", "chat.tools.autoApprove"].find((k) => d[k] === true);
    if (key) add(ctx, "C06", "warn", "VS Code", file, null, "Copilot agent mode runs every tool and terminal command without asking.", `${key} = true`);
  });
  visit("Gemini CLI", path.join(geminiDir, "settings.json"), "json", (d, file) => {
    auditServers(ctx, "Gemini CLI", file, "user", d["mcpServers"]);
    for (const [name, s] of Object.entries(rec(d["mcpServers"]) ?? {})) if (rec(s)?.["trust"] === true) add(ctx, "C06", "warn", "Gemini CLI", file, name, "Gemini CLI runs this server's tools without asking (trust: true).", "trust = true");
  });
  visit("Codex", path.join(codexHome, "config.toml"), "toml", (d, file) => auditCodex(ctx, file, d, "user"));

  for (const root of [...new Set(context.projectRoots)].filter((r) => path.resolve(r) !== path.resolve(home))) {
    mcpFile("Claude Code", path.join(root, ".mcp.json"), "mcpServers", "project");
    mcpFile("Cursor", path.join(root, ".cursor", "mcp.json"), "mcpServers", "project");
    mcpFile("VS Code", path.join(root, ".vscode", "mcp.json"), "servers", "project");
    visit("Gemini CLI", path.join(root, ".gemini", "settings.json"), "json", (d, file) => {
      const n = auditServers(ctx, "Gemini CLI", file, "project", d["mcpServers"]);
      if (n > 0) add(ctx, "C08", "info", "Gemini CLI", file, null, `This folder adds ${n} MCP server${n === 1 ? "" : "s"}. Check them before you trust the folder.`);
    });
    for (const f of ["settings.json", "settings.local.json"]) visit("Claude Code", path.join(root, ".claude", f), "json", (d, file) => auditClaudeSettings(ctx, file, d));
    visit("Codex", path.join(root, ".codex", "config.toml"), "toml", (d, file) => auditCodex(ctx, file, d, "project"));
  }

  const instructions: InstructionWeight[] = [];
  for (const [client, abs] of [["Claude Code", path.join(claudeDir, "CLAUDE.md")], ["Codex", path.join(codexHome, "AGENTS.md")], ["Codex", path.join(codexHome, "AGENTS.override.md")], ["Gemini CLI", path.join(geminiDir, "GEMINI.md")]] as const) {
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      const chars = st.size > MAX_SETTINGS_BYTES ? st.size : readFileSync(abs, "utf8").length;
      instructions.push({ client, file: displayPath(abs, home), bytes: st.size, tokens: estimateTokens(chars) });
    } catch {
      // Not present.
    }
  }
  for (const w of instructions.filter((x) => x.tokens >= 2000)) {
    add(ctx, "C09", w.tokens >= 8000 ? "warn" : "info", w.client, w.file, null, `Adds about ${w.tokens.toLocaleString("en-US")} tokens to every ${w.client} session before you type anything. Trim rules the assistant does not need everywhere, or move them into the projects that need them.`);
  }

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  ctx.findings.sort((a, b) => order[a.severity] - order[b.severity] || a.checkId.localeCompare(b.checkId));
  const count = (s: Severity): number => ctx.findings.filter((f) => f.severity === s).length;
  return {
    checkedAt: new Date().toISOString(),
    clients: [...clients].map(([client, files]) => ({ client, files })),
    servers: ctx.servers,
    instructions,
    findings: ctx.findings,
    summary: { errors: count("error"), warnings: count("warn"), notes: count("info") },
    caveats: SETUP_CAVEATS,
  };
}
