/**
 * Clean-install check of the packed tarball (run npm run pack:check first). Installs it
 * into a fresh temp folder OUTSIDE the repository with install scripts disabled, then
 * drives the INSTALLED binaries only: help, doctor, project add, scan, findings, and a real
 * MCP stdio handshake + tool calls. Synthetic data only; nothing is published.
 * Usage: node scripts/installCheck.ts [--keep]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarballs = readdirSync(path.join(REPO, "artifacts", "pack")).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error("run npm run pack:check first (expected exactly one tarball)");
const TARBALL = path.join(REPO, "artifacts", "pack", tarballs[0] ?? "");

const results: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail = ""): void => {
  results.push({ step, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}\n`);
};

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "agentlore-install-")));
const app = path.join(base, "app");
const ws = path.join(base, "workspace");
const project = path.join(base, "synthetic-project");
mkdirSync(app);
writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "agentlore-install-check", private: true }));
try {
  record("install folder is outside the repository", !base.startsWith(REPO) && !REPO.startsWith(base), base.replace(/.*\//, "<tmp>/"));
  const t0 = performance.now();
  const inst = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", TARBALL], { cwd: app, encoding: "utf8" });
  record("npm install <tarball> (scripts disabled)", inst.status === 0, `${Math.round(performance.now() - t0)} ms${inst.status === 0 ? "" : `: ${inst.stderr.slice(-400)}`}`);
  if (inst.status !== 0) throw new Error("install failed");

  // Every installed package: no install-time scripts and no native build files.
  const nm = path.join(app, "node_modules");
  const manifests: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || depth > 6) continue;
      const p = path.join(dir, e.name);
      if (existsSync(path.join(p, "package.json")) && (e.name !== "node_modules")) manifests.push(path.join(p, "package.json"));
      walk(p, depth + 1);
    }
  };
  walk(nm, 0);
  const pkgs = new Map<string, string>();
  const scripted: string[] = [];
  for (const m of manifests) {
    const j = JSON.parse(readFileSync(m, "utf8"));
    if (typeof j.name !== "string" || typeof j.version !== "string") continue;
    if (!m.includes(`${path.sep}node_modules${path.sep}`)) continue;
    pkgs.set(`${j.name}@${j.version}`, m);
    for (const s of ["preinstall", "install", "postinstall"]) if (j.scripts?.[s]) scripted.push(`${j.name}:${s}`);
    if (existsSync(path.join(path.dirname(m), "binding.gyp"))) scripted.push(`${j.name}:binding.gyp`);
  }
  record("no installed package declares install scripts or native builds", scripted.length === 0, scripted.join(", ") || `${pkgs.size} package manifests checked`);
  const top = readdirSync(nm).filter((n) => !n.startsWith("."));
  record("installed top-level packages", true, top.join(" "));

  const bin = (name: string): string => path.join(nm, ".bin", name);
  const run = (args: string[]) => spawnSync(bin("agentlore"), args, { cwd: app, encoding: "utf8", env: { ...process.env, AGENTLORE_WORKSPACE: "", AGENTWEAVE_WORKSPACE: "" } });
  const help = run(["help"]);
  record("installed `agentlore help`", help.status === 0 && help.stdout.includes("Commands"), `exit ${help.status}`);

  const doc = run(["--workspace", ws, "doctor", "--json"]);
  const report = JSON.parse(doc.stdout || "{}");
  const deps = report.checks?.find((c: { id: string }) => c.id === "dependencies");
  record("installed `agentlore doctor`", doc.status === 0 && deps?.status === "ok" && !existsSync(ws), `${deps?.message}; workspace not created: ${!existsSync(ws)}`);
  record("doctor launch command points at the installed package", String(report.launch?.mcp ?? "").includes(path.join(nm, "agentlore", "bin", "agentlore-mcp.mjs")) && !String(report.launch?.mcp).includes(REPO));

  mkdirSync(path.join(project, "skills", "release"), { recursive: true });
  mkdirSync(path.join(project, "services", "api"), { recursive: true });
  const files: Record<string, string> = {
    "AGENTS.md": "# Synthetic\n- Use npm to run scripts.\n- Always run tests.\n",
    "CLAUDE.md": "@AGENTS.md\n@docs/missing.md\n",
    "services/api/AGENTS.md": "# API\n- Use pnpm to run scripts.\n",
    "skills/release/SKILL.md": "---\nname: Release_Notes\n---\nBody.\n",
  };
  for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(project, rel), text);
  const hashAll = (): string => Object.keys(files).sort().map((rel) => `${rel}:${createHash("sha256").update(readFileSync(path.join(project, rel))).digest("hex")}`).join("\n");
  const before = hashAll();

  const add = run(["--workspace", ws, "project", "add", project, "--name", "synthetic"]);
  record("installed `project add`", add.status === 0, add.stdout.trim().split("\n")[0]?.replace(base, "<tmp>"));
  const list = run(["--workspace", ws, "status", "--json"]);
  const projectId = JSON.parse(list.stdout).projects?.[0]?.projectId as string;
  const scan = run(["--workspace", ws, "scan", projectId, "--json"]);
  const scanJson = JSON.parse(scan.stdout || "{}");
  record("installed `scan`", scan.status === 0 && scanJson.sources === 4, `sources ${scanJson.sources}, structural findings ${scanJson.structuralFindings}`);
  const findings = run(["--workspace", ws, "findings", projectId, "--json"]);
  const fj = JSON.parse(findings.stdout || "{}");
  const ids = JSON.stringify(fj).match(/"checkId":"[A-Z]\d\d"/g) ?? [];
  record("installed `findings`", findings.status === 0 && ids.length > 0, [...new Set(ids.map((s) => s.slice(11, 14)))].sort().join(" "));

  // MCP stdio handshake against the installed server binary, from the install folder.
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(nm, "agentlore", "bin", "agentlore-mcp.mjs"), "--workspace", ws], cwd: app, stderr: "pipe" });
  const client = new Client({ name: "agentlore-install-check", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  const info = client.getServerVersion();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  record("MCP handshake with the installed server", info?.name === "agentlore", `server ${info?.name} ${info?.version}, protocol ${client.getNegotiatedProtocolVersion()}`);
  record("MCP tools exposed (no approve/apply)", tools.length === 13 && !tools.some((t) => /approve|apply|reject|register|shell/.test(t)), tools.join(" "));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const first = r.content[0];
    return { isError: r.isError === true, data: first && first.type === "text" ? JSON.parse(first.text) : null };
  };
  const projects = await call("projects_list", {});
  record("MCP projects_list", !projects.isError && projects.data.projects?.length === 1);
  const sources = await call("sources_list", { projectId });
  const root = sources.data.sources?.find((s: { relPath: string }) => s.relPath === "AGENTS.md");
  const read = await call("source_read", { projectId, sourceId: root?.sourceId });
  record("MCP source_read", !read.isError && read.data.lines?.length === 3);
  const propose = await call("change_propose", {
    projectId, requestKey: "install-check-1",
    sourceId: root.sourceId, baseVersionId: read.data.versionId, findingIds: [], rationale: "install check (synthetic)",
    edits: [{ startLine: 2, endLine: 2, expectedText: "- Use npm to run scripts.", replacementLines: ["- Use npm to run scripts (services/api uses pnpm)."] }],
  });
  record("MCP change_propose stores a pending proposal", !propose.isError && JSON.stringify(propose.data).includes("pending"), propose.isError ? JSON.stringify(propose.data).slice(0, 200) : "");
  const listed = await call("changes_list", { projectId });
  record("MCP changes_list", !listed.isError && listed.data.proposals?.length === 1 && !JSON.stringify(listed.data).includes("proposalSha256"));
  await client.close();
  record("project files unchanged by scan, MCP reads and propose", hashAll() === before);

  const installedText = manifests.filter((m) => m.includes(`${path.sep}agentlore${path.sep}`)).length;
  const grep = spawnSync("grep", ["-rl", REPO, path.join(nm, "agentlore")], { encoding: "utf8" });
  record("installed package contains no repository path", grep.stdout.trim() === "", `${installedText} manifest(s) checked`);
} catch (e) {
  record("unexpected error", false, e instanceof Error ? e.message.replace(base, "<tmp>") : String(e));
} finally {
  if (!process.argv.includes("--keep")) rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} install checks passed\n`);
process.exit(failed ? 1 : 0);
