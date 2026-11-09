#!/usr/bin/env node
// Installed-package entry point for the mcp. Plain JavaScript so an unsupported Node
// gets a clear message instead of a module error (node:sqlite needs a recent Node).
const [major] = process.versions.node.split(".").map(Number);
if (!(major >= 24)) {
  process.stderr.write(`agentlore-mcp: Node ${process.versions.node} is not supported. Agentlore needs Node 24 or newer (only 26.8.2 has been tested).\n`);
  process.exit(1);
}
await import("../build/mcp/main.js");
