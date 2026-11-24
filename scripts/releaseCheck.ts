/**
 * Release-candidate gate. Never publishes. Steps:
 *   1. packCheck --release: stage a copy without "private", pack it into artifacts/release/
 *      (never overwritten), and audit the tarball.
 *   2. installCheck against that exact file, once per Node runtime given with --node
 *      (the current Node is always included).
 *   3. npm publish --dry-run on that exact file, with --tag alpha --access public.
 *   4. Confirm the tarball's sha512 did not change, and write <tarball>.release.json.
 * Usage: node scripts/releaseCheck.ts [--node /path/to/node24 ...]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodes = [process.execPath, ...process.argv.flatMap((a, i) => (a === "--node" && process.argv[i + 1] ? [path.resolve(process.argv[i + 1] ?? "")] : []))];
const sha512 = (f: string): string => `sha512-${createHash("sha512").update(readFileSync(f)).digest("base64")}`;

// --existing re-verifies a release file that was already packed (it is never re-packed or overwritten).
const EXISTING = process.argv.includes("--existing");
const report = ((): { tarball: string; name: string; version: string; entryCount: number; packedBytes: number; npmIntegrity: string; sha256: string; files: string[]; problems: string[] } => {
  if (EXISTING) {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    const rel = `artifacts/release/${pkg.name}-${pkg.version}.tgz`;
    const prior = JSON.parse(readFileSync(path.join(REPO, `${rel}.release.json`), "utf8"));
    const listed = spawnSync("tar", ["-tzf", path.join(REPO, rel)], { encoding: "utf8" }).stdout.trim().split("\n").map((f) => f.replace(/^package\//, "")).sort();
    const problems = JSON.stringify(listed) === JSON.stringify([...prior.files].sort()) ? [] : ["file list differs from the recorded release"];
    if (sha512(path.join(REPO, rel)) !== prior.integrity) problems.push("sha512 differs from the recorded release");
    return { tarball: rel, name: pkg.name, version: pkg.version, entryCount: listed.length, packedBytes: readFileSync(path.join(REPO, rel)).length, npmIntegrity: prior.integrity, sha256: prior.sha256, files: listed, problems };
  }
  const pack = spawnSync(process.execPath, [path.join(REPO, "scripts/packCheck.ts"), "--release", "--json"], { cwd: REPO, encoding: "utf8" });
  if (!pack.stdout.trim().startsWith("{") || pack.status !== 0) {
    process.stderr.write(`release pack failed:\n${pack.stdout.slice(-800)}${pack.stderr.slice(-800)}\n`);
    process.exit(1);
  }
  return JSON.parse(pack.stdout);
})();
const tarball = path.join(REPO, report.tarball);
const before = sha512(tarball);
process.stdout.write(`tarball   ${report.tarball}\nfiles     ${report.entryCount}, ${report.packedBytes} bytes packed\nintegrity ${before}\nnpm said  ${report.npmIntegrity}\n`);
const gates: { gate: string; ok: boolean; detail: string }[] = [];
gates.push({ gate: EXISTING ? "existing release file matches its record" : "release pack audit", ok: report.problems.length === 0, detail: report.problems.join("; ") || (EXISTING ? "same files, same sha512" : "allowlist, no scripts, licence, no private paths") });
gates.push({ gate: "our sha512 equals npm pack integrity", ok: before === report.npmIntegrity, detail: "" });

for (const node of nodes) {
  const r = spawnSync(process.execPath, [path.join(REPO, "scripts/installCheck.ts"), "--tarball", tarball, "--node", node], { cwd: REPO, encoding: "utf8" });
  const summary = r.stdout.trim().split("\n").pop() ?? "";
  gates.push({ gate: `clean install + CLI + MCP on ${spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim()}`, ok: r.status === 0, detail: r.status === 0 ? summary : r.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("; ") });
}

// --loglevel notice: `npm run -s` passes silent down, which hides the tag line checked below.
const dry = spawnSync("npm", ["publish", "--dry-run", "--json", "--loglevel", "notice", "--tag", "alpha", "--access", "public", "--registry", "https://registry.npmjs.org/", tarball], { cwd: path.dirname(tarball), encoding: "utf8" });
const loggedOut = /requires you to be logged in/.test(dry.stderr);
const tagged = /with tag alpha and public access/.test(dry.stderr);
try {
  const parsed = JSON.parse(dry.stdout.slice(dry.stdout.indexOf("{")));
  const j = parsed.id ? parsed : parsed[report.name];
  gates.push({ gate: "npm publish --dry-run (exact tarball, tag alpha, public)", ok: dry.status === 0 && j?.integrity === before && j?.id === `${report.name}@${report.version}` && tagged, detail: `${j?.id}, ${j?.entryCount} files, integrity matches: ${j?.integrity === before}, tag alpha + public: ${tagged}` });
} catch {
  gates.push({ gate: "npm publish --dry-run (exact tarball, tag alpha, public)", ok: false, detail: `exit ${dry.status}: ${dry.stderr.slice(-300)}` });
}
process.stdout.write(loggedOut ? "NOTE  npm is not signed in on this machine (the dry run warned); a real publish needs `npm login` first.\n" : "NOTE  npm reports a signed-in session for the dry run.\n");

const after = sha512(tarball);
gates.push({ gate: "tarball unchanged by every check", ok: after === before, detail: "" });
for (const g of gates) process.stdout.write(`${g.ok ? "PASS" : "FAIL"}  ${g.gate}${g.detail ? ` — ${g.detail}` : ""}\n`);
const ok = gates.every((g) => g.ok);
writeFileSync(`${tarball}.release.json`, `${JSON.stringify({ npmSignedIn: !loggedOut, name: report.name, version: report.version, tarball: report.tarball, integrity: before, sha256: report.sha256, files: report.files, gates, checkedAt: new Date().toISOString(), ready: ok }, null, 2)}\n`);
process.stdout.write(ok
  ? `\nREADY. Nothing was published. To publish this exact file (a person, in a normal terminal, with npm 2FA):\n  npm publish ./${report.tarball} --tag alpha --access public --registry https://registry.npmjs.org/\n`
  : "\nNOT READY. Fix the FAIL items; the tarball must be rebuilt under a new version or deleted by hand if it was never published.\n");
process.exit(ok ? 0 : 1);
