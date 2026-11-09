/**
 * Bounded, measured load run on SYNTHETIC monorepos (scripts/bigFixture.ts). Each tier runs
 * in its own child process so memory numbers are per tier. Times are wall clock on this one
 * machine (performance.now); memory is the highest process RSS sampled every 5 ms during
 * the operation. These numbers describe this machine and run only.
 * Usage: node scripts/loadTest.ts [--json]
 */
import { spawnSync } from "node:child_process";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir, cpus, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";

const TIERS = {
  "t1-2k": { packages: 50, otherFilesPerPackage: 40, skillsPerPackage: 2 },
  "t2-5k": { packages: 100, otherFilesPerPackage: 45, skillsPerPackage: 2 },
  "t3-over-limit": { packages: 100, otherFilesPerPackage: 10, skillsPerPackage: 2, overflow: 300 },
} as const;
type Tier = keyof typeof TIERS;

async function runTier(name: Tier): Promise<unknown> {
  const { generateBigProject, snapshotTree, diffSnapshots } = await import("./bigFixture.ts");
  const { WorkspaceStore, DB_FILE } = await import("../src/core/store.ts");
  const { createOperatorService } = await import("../src/core/service/operator.ts");
  const { createAssistantService } = await import("../src/core/service/assistant.ts");
  const base = await realpath(mkdtempSync(path.join(tmpdir(), `agentweave-load-${name}-`)));
  const root = path.join(base, "monorepo");
  await mkdir(root);
  let peak = 0;
  const timed = async <T>(fn: () => Promise<T> | T): Promise<{ ms: number; peakRssMiB: number; value: T }> => {
    peak = process.memoryUsage().rss;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const t0 = performance.now();
    try {
      const value = await fn();
      return { ms: Math.round(performance.now() - t0), peakRssMiB: Math.round(Math.max(peak, process.memoryUsage().rss) / 1048576), value };
    } finally {
      clearInterval(timer);
    }
  };
  try {
    const gen = await timed(() => generateBigProject(root, TIERS[name]));
    const before = await snapshotTree(root);
    const store = WorkspaceStore.open(path.join(base, "workspace"));
    const ops = createOperatorService(store, { actor: () => "local-user:load", homeReal: await realpath(homedir()) });
    const reg = await ops.registerProject(root, name);
    if (!reg.ok) throw new Error(reg.error.message);
    const projectId = reg.value.project.id;
    const svc = createAssistantService(store, { reporter: () => "assistant:load", onInternalError: (op, e) => { throw new Error(`${op}: ${String(e)}`); } });
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
    const scan1 = await timed(async () => must(await svc.scan({ projectId })));
    const scan2 = await timed(async () => must(await svc.scan({ projectId })));
    const fresh = await timed(async () => must(await svc.freshness({ projectId })));
    const status = await timed(async () => must(await svc.projectStatus({ projectId })));
    const findings = await timed(() => must(svc.listFindings({ projectId })));
    const sources = must(svc.listSources({ projectId }));
    const target = sources.sources.find((s) => s.relPath === "packages/p1/AGENTS.md");
    if (!target) throw new Error("fixture source missing");
    const read = must(svc.readSource({ projectId, sourceId: target.sourceId }));
    const propose = await timed(() => must(svc.proposeChange({
      projectId, requestKey: "load-propose-1", sourceId: target.sourceId, baseVersionId: read.versionId, findingIds: [], rationale: "load test",
      edits: [{ startLine: 3, endLine: 3, expectedText: "- Use npm to run scripts in this package.", replacementLines: ["- Use pnpm to run scripts in this package."] }],
    })));
    const changed = diffSnapshots(before, await snapshotTree(root));
    store.close();
    const db = await stat(path.join(base, "workspace", DB_FILE));
    const byCheck: Record<string, number> = {};
    for (const f of findings.value.findings) byCheck[f.checkId] = (byCheck[f.checkId] ?? 0) + 1;
    const notReadByReason: Record<string, number> = {};
    for (const n of sources.notRead) notReadByReason[n.reason] = (notReadByReason[n.reason] ?? 0) + 1;
    return {
      tier: name, options: TIERS[name], fixture: gen.value, generateMs: gen.ms,
      scanFirst: { ms: scan1.ms, peakRssMiB: scan1.peakRssMiB, sources: scan1.value.sources, exclusions: scan1.value.exclusions, skipped: scan1.value.skipped, structuralFindings: scan1.value.structuralFindings },
      scanUnchanged: { ms: scan2.ms, peakRssMiB: scan2.peakRssMiB, newVersions: scan2.value.newVersions },
      freshness: { ms: fresh.ms, state: fresh.value.freshness.state },
      status: { ms: status.ms, partial: status.value.scan.state === "scanned" ? status.value.scan.partial : null, partialReasons: status.value.scan.state === "scanned" ? status.value.scan.partialReasons.length : 0 },
      findings: { ms: findings.ms, total: findings.value.findings.length, byCheck },
      propose: { ms: propose.ms },
      notReadByReason, workspaceDbBytes: db.size, sourceBytesChanged: changed.length,
    };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const tierArg = process.argv.indexOf("--tier");
if (tierArg >= 0) {
  const name = process.argv[tierArg + 1] as Tier;
  if (!(name in TIERS)) throw new Error("unknown tier");
  process.stdout.write(`${JSON.stringify(await runTier(name))}\n`);
} else {
  const self = fileURLToPath(import.meta.url);
  const results = Object.keys(TIERS).map((name) => {
    const r = spawnSync(process.execPath, [self, "--tier", name], { encoding: "utf8", timeout: 300_000 });
    if (r.status !== 0) return { tier: name, error: (r.stderr || "failed").slice(-500) };
    return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  });
  const machine = { node: process.versions.node, platform: `${process.platform}-${process.arch}`, cpu: cpus()[0]?.model, cpus: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30) };
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ machine, results }, null, 2)}\n`);
  else {
    process.stdout.write(`machine: ${JSON.stringify(machine)}\n`);
    for (const r of results) process.stdout.write(`${JSON.stringify(r)}\n`);
  }
  if (results.some((r) => "error" in r || r.sourceBytesChanged !== 0)) process.exit(1);
}
