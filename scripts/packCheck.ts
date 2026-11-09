/**
 * Builds the real npm tarball (npm pack, which runs prepack -> build) into artifacts/pack/
 * and audits it: exact file allowlist, no install-time scripts, no private paths, secrets,
 * databases, backups, tests or TypeScript sources. Prints file list, size and SHA-256.
 * Local only: never publishes.  Usage: node scripts/packCheck.ts [--json] [--release]
 *   default    preview: requires "private": true as an accidental-publish guard
 *   --release  release candidate: requires private removed, a real licence (not UNLICENSED)
 *              and a LICENSE file in the tarball. Still never publishes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/**
 * Release mode packs a staged copy, never the repository itself, so the repository keeps
 * "private": true as an accidental-publish guard. The staged manifest drops "private",
 * "scripts" and "devDependencies" (none matter to someone installing the package).
 * The tarball goes to artifacts/release/ and is never overwritten: a release file is immutable.
 */
const RELEASE_EARLY = process.argv.includes("--release");
const packFrom = ((): string => {
  if (!RELEASE_EARLY) return REPO;
  const stage = mkdtempSync(path.join(tmpdir(), "agentsol-release-stage-"));
  const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  delete manifest.private; delete manifest.scripts; delete manifest.devDependencies;
  writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of ["README.md", "LICENSE"]) cpSync(path.join(REPO, f), path.join(stage, f));
  cpSync(path.join(REPO, "bin"), path.join(stage, "bin"), { recursive: true });
  cpSync(path.join(REPO, "build"), path.join(stage, "build"), { recursive: true });
  return stage;
})();
const OUT_DIR = RELEASE_EARLY ? path.join(REPO, "artifacts", "release") : DEST;
await mkdir(OUT_DIR, { recursive: true });
const expectedName = ((): string => {
  const m = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  return `${m.name}-${m.version}.tgz`;
})();
if (RELEASE_EARLY && existsSync(path.join(OUT_DIR, expectedName))) {
  throw new Error(`artifacts/release/${expectedName} already exists; release tarballs are never overwritten. Bump the version, or delete it yourself if it was never published.`);
}
const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", OUT_DIR], packFrom).replace(/^[^[]*/, ""));
if (packFrom !== REPO) rmSync(packFrom, { recursive: true, force: true });
const info = packed[0];
const tarball = path.join(OUT_DIR, info.filename);
const files: string[] = info.files.map((f: { path: string }) => f.path).sort();

const RELEASE = RELEASE_EARLY;
const problems: string[] = [];
const allowed = (f: string): boolean =>
  f === "package.json" || f === "README.md" || f === "LICENSE" || f === "bin/agentsol.mjs" || f === "bin/agentsol-mcp.mjs" || /^build\/(core|cli|mcp)(\/service)?\/[A-Za-z]+\.js$/.test(f);
for (const f of files) if (!allowed(f)) problems.push(`not on the allowlist: ${f}`);
for (const must of ["package.json", "README.md", "LICENSE", "bin/agentsol.mjs", "bin/agentsol-mcp.mjs", "build/cli/main.js", "build/mcp/main.js", "build/core/store.js"]) if (!files.includes(must)) problems.push(`missing: ${must}`);

const dir = mkdtempSync(path.join(tmpdir(), "agentsol-packcheck-"));
try {
  run("tar", ["-xzf", tarball, "-C", dir]);
  const pkg = JSON.parse(readFileSync(path.join(dir, "package", "package.json"), "utf8"));
  for (const s of ["preinstall", "install", "postinstall", "prepare", "preuninstall", "uninstall", "postuninstall"]) if (pkg.scripts?.[s]) problems.push(`install-time script present: ${s}`);
  if (RELEASE) {
    if (pkg.private === true) problems.push("release: package.json is still private: true");
    if (typeof pkg.license !== "string" || pkg.license === "" || pkg.license === "UNLICENSED") problems.push("release: no licence chosen (license is UNLICENSED or missing)");
    if (!files.includes("LICENSE")) problems.push("release: LICENSE file missing from the tarball");
    if (pkg.publishConfig?.tag !== "alpha" && /-/.test(pkg.version)) problems.push("release: prerelease version without publishConfig.tag \"alpha\"");
    if (pkg.scripts !== undefined || pkg.devDependencies !== undefined) problems.push("release: staged manifest still has scripts or devDependencies");
  } else if (pkg.private !== true) problems.push("package.json is not private: true (publish guard removed); use --release for a release candidate");
  for (const k of ["name", "version", "bin", "engines", "description"]) if (pkg[k] === undefined) problems.push(`package.json missing ${k}`);
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
      if (rel === "LICENSE" && what === "user name") continue; // the copyright holder's name is intentional
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
  sha512Integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  files, problems, mode: RELEASE ? "release" : "preview",
};
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`${report.tarball}\n${report.entryCount} files, ${report.packedBytes} bytes packed, ${report.unpackedBytes} bytes unpacked\nsha256 ${report.sha256}\n`);
  for (const f of files) process.stdout.write(`  ${f}\n`);
  process.stdout.write(problems.length ? `PROBLEMS:\n${problems.map((p) => `  ${p}`).join("\n")}\n` : "Pack audit passed.\n");
}
process.exit(problems.length ? 1 : 0);
