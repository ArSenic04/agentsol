#!/usr/bin/env node
// Installed-package entry point for the cli. Plain JavaScript so an unsupported Node
// gets a clear message instead of a module error (node:sqlite needs a recent Node).
const [major] = process.versions.node.split(".").map(Number);
if (!(major >= 24)) {
  process.stderr.write(`agentsol: Node ${process.versions.node} is not supported. Agentsol needs Node 24 or newer (tested on 24.0.0, 24.22.2 and 26.8.2).\n`);
  process.exit(1);
}
// The guard hook runs before every shell command an agent runs, so it skips loading the full CLI.
if (process.argv[2] === "guard") {
  const { guardCli } = await import("../build/cli/guard.js");
  process.exitCode = await guardCli(process.argv.slice(3));
} else await import("../build/cli/main.js");
