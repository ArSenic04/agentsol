import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WorkspaceStore } from "../core/store.ts";
import { workspaceFrom } from "../core/workspaceArg.ts";
import { createAgentloreServer } from "./server.ts";

const { dir } = workspaceFrom(process.argv.slice(2), process.env);
if (!dir) {
  console.error("agentlore-mcp: pass --workspace <dir> or set AGENTLORE_WORKSPACE (the same workspace the CLI uses).");
  process.exit(2);
}
const store = WorkspaceStore.open(dir);
const handle = serveStdio(() => createAgentloreServer(store));
console.error("agentlore MCP server listening on stdio (read/audit/propose only; approval and apply are CLI-only)");

const shutdown = (): void => {
  void handle.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
