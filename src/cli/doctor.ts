/**
 * Non-destructive preflight. Reads versions, the local lockfile and installed package
 * manifests, and inspects the workspace folder WITHOUT creating, migrating or writing it.
 * No network, no client configuration, no environment variable values are printed.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { detectAgentEnvironment } from "../core/agentEnv.ts";
import { DB_FILE, SCHEMA_VERSION } from "../core/store.ts";

/** The only Node version this repository has actually been tested on. */
export const TESTED_NODE = "26.8.2";
export const MIN_NODE_MAJOR = 24;

export type CheckStatus = "ok" | "warn" | "fail" | "info";
export type DoctorCheck = { id: string; status: CheckStatus; message: string };
export type DoctorReport = {
  checks: DoctorCheck[];
  launch: { cli: string; mcp: string; mcpClientConfig: { command: string; args: string[] } } | null;
  ok: boolean;
};

const PackageJson = z.object({ engines: z.object({ node: z.string() }).optional(), dependencies: z.record(z.string(), z.string()).default({}), devDependencies: z.record(z.string(), z.string()).default({}) });
const LockJson = z.object({ lockfileVersion: z.number(), packages: z.record(z.string(), z.object({ version: z.string().optional() })) });
const VersionOnly = z.object({ version: z.string() });

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function dependencyChecks(repo: string): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const pkg = PackageJson.safeParse(readJson(path.join(repo, "package.json")));
  if (!pkg.success) return [{ id: "package_json", status: "fail", message: "package.json could not be parsed" }];
  const lockPath = path.join(repo, "package-lock.json");
  if (!existsSync(lockPath)) return [{ id: "lockfile", status: "fail", message: "package-lock.json is missing; reinstalls would not be reproducible" }];
  const lock = LockJson.safeParse(readJson(lockPath));
  if (!lock.success) return [{ id: "lockfile", status: "fail", message: "package-lock.json could not be parsed" }];
  out.push({ id: "lockfile", status: "ok", message: `package-lock.json present (lockfileVersion ${lock.data.lockfileVersion})` });
  const names = [...Object.keys(pkg.data.dependencies), ...Object.keys(pkg.data.devDependencies)].sort();
  const problems: string[] = [];
  for (const name of names) {
    const locked = lock.data.packages[`node_modules/${name}`]?.version;
    const manifest = path.join(repo, "node_modules", name, "package.json");
    const installed = existsSync(manifest) ? VersionOnly.safeParse(readJson(manifest)) : null;
    if (!locked) problems.push(`${name}: not in lockfile`);
    else if (!installed || !installed.success) problems.push(`${name}: not installed (locked ${locked})`);
    else if (installed.data.version !== locked) problems.push(`${name}: installed ${installed.data.version}, locked ${locked}`);
  }
  out.push(problems.length === 0
    ? { id: "dependencies", status: "ok", message: `${names.length} direct dependencies installed at the locked versions` }
    : { id: "dependencies", status: "fail", message: `${problems.join("; ")}. Run: npm ci` });
  return out;
}

function workspaceChecks(dir: string): DoctorCheck[] {
  const abs = path.resolve(dir);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return [{ id: "workspace", status: "info", message: "Workspace folder does not exist yet; the first CLI command creates it with mode 0700" }];
  }
  if (st.isSymbolicLink()) return [{ id: "workspace", status: "fail", message: "Workspace path is a symlink; AgentWeave refuses it. Use a real folder." }];
  if (!st.isDirectory()) return [{ id: "workspace", status: "fail", message: "Workspace path exists but is not a folder" }];
  if ((st.mode & 0o077) !== 0) return [{ id: "workspace", status: "fail", message: `Workspace folder is accessible by other users (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 700 <workspace>` }];
  const out: DoctorCheck[] = [{ id: "workspace", status: "ok", message: "Workspace folder exists, is private (no group/other access) and is not a symlink" }];
  const db = path.join(abs, DB_FILE);
  if (!existsSync(db)) {
    out.push({ id: "workspace_db", status: "info", message: "No workspace database yet; it is created on first use" });
    return out;
  }
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const version = z.object({ value: z.string() }).safeParse(conn.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get());
      const projects = z.object({ n: z.number() }).parse(conn.prepare("SELECT COUNT(*) AS n FROM projects").get()).n;
      const v = version.success ? version.data.value : "unknown";
      out.push(v === SCHEMA_VERSION
        ? { id: "workspace_db", status: "ok", message: `Workspace database schema ${v}; ${projects} registered project(s)` }
        : { id: "workspace_db", status: "info", message: `Workspace database schema ${v}; ${projects} registered project(s). It is upgraded to schema ${SCHEMA_VERSION} (additive) the next time the CLI or MCP server opens it; rescan projects to enable freshness checks.` });
    } finally {
      conn.close();
    }
  } catch {
    out.push({ id: "workspace_db", status: "warn", message: "Workspace database exists but could not be opened read-only (it may be in use or damaged)" });
  }
  return out;
}

export function runDoctor(args: { repo: string; workspace: string | null; env: NodeJS.ProcessEnv; isTTY: boolean }): DoctorReport {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(major >= MIN_NODE_MAJOR
    ? { id: "node", status: process.versions.node === TESTED_NODE ? "ok" : "warn", message: `Node ${process.versions.node}${process.versions.node === TESTED_NODE ? " (the tested version)" : `; only Node ${TESTED_NODE} has been tested`}` }
    : { id: "node", status: "fail", message: `Node ${process.versions.node} is older than ${MIN_NODE_MAJOR}` });
  checks.push({ id: "sqlite", status: "ok", message: "node:sqlite is available" });
  checks.push(...dependencyChecks(args.repo));
  if (args.workspace) checks.push(...workspaceChecks(args.workspace));
  else checks.push({ id: "workspace", status: "info", message: "No workspace given. Pass --workspace <dir> or set AGENTWEAVE_WORKSPACE to check one." });
  const agent = detectAgentEnvironment(args.env);
  checks.push(agent
    ? { id: "terminal", status: "warn", message: `This terminal looks agent-driven (${agent.variable} is set): approve, reject and apply will refuse here. Run them yourself in a normal terminal.` }
    : args.isTTY
      ? { id: "terminal", status: "ok", message: "Interactive terminal; approve, reject and apply can run here" }
      : { id: "terminal", status: "info", message: "Not an interactive terminal; approve, reject and apply need one" });
  const ws = args.workspace ? path.resolve(args.workspace) : null;
  const launch = ws
    ? {
        cli: `node ${path.join(args.repo, "src/cli/main.ts")} --workspace "${ws}" status`,
        mcp: `node ${path.join(args.repo, "src/mcp/main.ts")} --workspace "${ws}"`,
        mcpClientConfig: { command: process.execPath, args: [path.join(args.repo, "src/mcp/main.ts"), "--workspace", ws] },
      }
    : null;
  return { checks, launch, ok: !checks.some((c) => c.status === "fail") };
}
