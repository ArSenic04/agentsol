/**
 * Builds the real npm tarball (npm pack, which runs prepack -> build) into artifacts/pack/
 * and audits it: exact file allowlist, no install-time scripts, no private paths, secrets,
 * databases, backups, tests or TypeScript sources. Prints file list, size and SHA-256.
 * Local only: never publishes.  Usage: node scripts/packCheck.ts [--json]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(REPO, "artifacts", "pack");
await mkdir(DEST, { recursive: true });
for (const f of readdirSync(DEST)) if (f.endsWith(".tgz")) rmSync(path.join(DEST, f));

const run = (cmd: string, args: string[], cwd = REPO): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
// Build explicitly: this repository's .npmrc sets ignore-scripts=true, so prepack does not run.
run(process.execPath, [path.join(REPO, "scripts", "buildPackage.ts")]);
const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", DEST]).replace(/^[^[]*/, ""));
const info = packed[0];
const tarball = path.join(DEST, info.filename);
const files: string[] = info.files.map((f: { path: string }) => f.path).sort();

const problems: string[] = [];
const allowed = (f: string): boolean =>
  f === "package.json" || f === "README.md" || f === "bin/agentlore.mjs" || f === "bin/agentlore-mcp.mjs" || /^build\/(core|cli|mcp)(\/service)?\/[A-Za-z]+\.js$/.test(f);
for (const f of files) if (!allowed(f)) problems.push(`not on the allowlist: ${f}`);
for (const must of ["package.json", "README.md", "bin/agentlore.mjs", "bin/agentlore-mcp.mjs", "build/cli/main.js", "build/mcp/main.js", "build/core/store.js"]) if (!files.includes(must)) problems.push(`missing: ${must}`);

const dir = mkdtempSync(path.join(tmpdir(), "agentlore-packcheck-"));
try {
  run("tar", ["-xzf", tarball, "-C", dir]);
  const pkg = JSON.parse(readFileSync(path.join(dir, "package", "package.json"), "utf8"));
  for (const s of ["preinstall", "install", "postinstall", "prepare", "preuninstall", "uninstall", "postuninstall"]) if (pkg.scripts?.[s]) problems.push(`install-time script present: ${s}`);
  if (pkg.private !== true) problems.push("package.json is not private: true (publish guard removed)");
  const forbidden: [RegExp, string][] = [
    [/\/Users\/[a-z]/i, "macOS home path"], [/\/home\/[a-z]/, "Linux home path"], [/\/private\/var\/folders|\/var\/folders\//, "temp path"],
    [/shivam/i, "user name"], [/sk-[A-Za-z0-9]{20,}/, "secret-like token"], [/AKIA[0-9A-Z]{16}/, "AWS-like key"], [/-----BEGIN [A-Z ]*PRIVATE KEY/, "private key"],
    [/from "\.{1,2}\/[^"]+\.ts"/, "TypeScript import left in JS"], [/\/src\/(core|cli|mcp)\//, "repo source path"],
  ];
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const abs of walk(path.join(dir, "package"))) {
    const rel = path.relative(path.join(dir, "package"), abs);
    const text = readFileSync(abs, "utf8");
    for (const [re, what] of forbidden) {
      if (rel === "README.md" && (what === "repo source path" || what === "temp path")) continue; // docs may describe repo layout
      if (re.test(text)) problems.push(`${what} in ${rel}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const bytes = readFileSync(tarball);
const report = {
  tarball: path.relative(REPO, tarball),
  name: info.name, version: info.version,
  packedBytes: statSync(tarball).size, unpackedBytes: info.unpackedSize, entryCount: info.entryCount,
  sha256: createHash("sha256").update(bytes).digest("hex"), npmIntegrity: info.integrity,
  files, problems,
};
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`${report.tarball}\n${report.entryCount} files, ${report.packedBytes} bytes packed, ${report.unpackedBytes} bytes unpacked\nsha256 ${report.sha256}\n`);
  for (const f of files) process.stdout.write(`  ${f}\n`);
  process.stdout.write(problems.length ? `PROBLEMS:\n${problems.map((p) => `  ${p}`).join("\n")}\n` : "Pack audit passed.\n");
}
process.exit(problems.length ? 1 : 0);
