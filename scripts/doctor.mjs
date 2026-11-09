// Plain JavaScript on purpose: it must give a clear message on a Node version that
// cannot run the TypeScript sources at all, before importing them.
const [major] = process.versions.node.split(".").map(Number);
if (!(major >= 24) || !process.features?.typescript) {
  process.stderr.write(`agentlore doctor: Node ${process.versions.node} cannot run Agentlore. It needs Node 24 or newer with built-in TypeScript support (tested on 26.8.2).\n`);
  process.exit(1);
}
await import("../src/cli/main.ts");
