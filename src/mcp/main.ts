import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WorkspaceStore } from "../core/store.ts";
import { homedir } from "node:os";
import { resolveWorkspace } from "../core/workspaceArg.ts";
import { createAgentsolServer } from "./server.ts";

const { dir } = resolveWorkspace(process.argv.slice(2), process.env, homedir());
const store = WorkspaceStore.open(dir);
const handle = serveStdio(() => createAgentsolServer(store));
console.error("agentsol MCP server listening on stdio (read/audit/propose only; approval and apply are CLI-only)");

const shutdown = (): void => {
  void handle.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
