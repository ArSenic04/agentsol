/**
 * npm run web:local -- --workspace <dir> [--port 4317]   local read-only workspace browser
 * npm run web:preview [-- --port 4318]                     static demo only (no API)
 * Always binds 127.0.0.1. There is deliberately no --host option.
 */
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FILE, WorkspaceStore } from "../core/store.ts";
import { workspaceFrom } from "../core/workspaceArg.ts";
import { startWebServer } from "./server.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function die(msg: string): never {
  process.stderr.write(`agentweave-web: ${msg}\n`);
  process.exit(2);
}

const { dir, rest } = workspaceFrom(process.argv.slice(2), process.env);
const staticOnly = rest.includes("--static-only");
if (rest.some((a) => a === "--host" || a.startsWith("--host="))) die("there is no --host option; the server only listens on 127.0.0.1");
const portIdx = rest.indexOf("--port");
const portArg = portIdx >= 0 ? rest[portIdx + 1] : undefined;
const port = portArg === undefined ? (staticOnly ? 4318 : 4317) : Number(portArg);
if (!Number.isInteger(port) || port < 1024 || port > 65535) die("--port must be an integer from 1024 to 65535");
const distIdx = rest.indexOf("--dist");
const staticDir = path.resolve(distIdx >= 0 ? (rest[distIdx + 1] ?? "") : path.join(REPO, "dist", "web"));
if (!existsSync(path.join(staticDir, "index.html"))) die("no built site found; run: npm run web:build");

function openWorkspace(d: string | null): WorkspaceStore {
  if (!d) die("pass --workspace <dir> (an existing AgentWeave workspace), or use npm run web:preview for the static demo");
  const ws = path.resolve(d);
  let isDir = false;
  try {
    const st = lstatSync(ws);
    isDir = st.isDirectory() && !st.isSymbolicLink();
  } catch {
    die("that workspace does not exist. Create one with the CLI first, or run: npm run demo");
  }
  if (!isDir) die("the workspace must be a real folder, not a file or symlink");
  if (!existsSync(path.join(ws, DB_FILE))) die("that folder is not an AgentWeave workspace (no workspace.sqlite); nothing was created");
  try {
    return WorkspaceStore.open(ws);
  } catch (e) {
    return die(e instanceof Error ? e.message : "could not open the workspace");
  }
}

const store = staticOnly ? null : openWorkspace(dir);
let running;
try {
  running = await startWebServer({ store, staticDir, port });
} catch (e) {
  const code = e instanceof Error && "code" in e ? e.code : undefined;
  die(code === "EADDRINUSE" ? `port ${port} is in use; pass --port <n>` : `could not start: ${e instanceof Error ? e.message : String(e)}`);
}
process.stdout.write(`AgentWeave ${staticOnly ? "static demo preview" : "local workspace (read-only)"} at ${running.url}  (pid ${process.pid}; 127.0.0.1 only; Ctrl+C to stop)\n`);
const shutdown = (): void => {
  void running.close().finally(() => {
    store?.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
