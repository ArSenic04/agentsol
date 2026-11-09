import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEMO_FILES } from "../scripts/demoFixture.ts";
import { tempDir } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = (...args: string[]) =>
  spawnSync(process.execPath, [path.join(REPO, "scripts", "demo.ts"), ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });

test("demo creates a synthetic project, proposes over real MCP stdio, and writes nothing to the project", async () => {
  const base = await tempDir("demo");
  const dir = path.join(base, "demo");
  const r = demo("--dir", dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Proposed change \(nothing written yet\)/);
  assert.match(r.stdout, /\[REDACTED:api_key\]/);
  assert.ok(!r.stdout.includes("sk-DEMOFAKE"), "fake key never printed from MCP output");
  assert.ok(!r.stdout.includes(".env.local ("), "secret-like file is not listed by name");
  for (const [rel, content] of Object.entries(DEMO_FILES)) assert.equal(await readFile(path.join(dir, "project", rel), "utf8"), content, rel);

  const id = /review (chg_[0-9a-f]{16})/.exec(r.stdout)?.[1];
  assert.ok(id, "first run prints the proposal to review");
  assert.match(r.stdout, /npm run doctor -- --workspace/);

  // Rerunning keeps the demo and its proposal, and explains what to do next.
  const again = demo("--dir", dir);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already exists .* kept as is/);
  assert.match(again.stdout, new RegExp(`proposal ${id}: pending`));
  assert.match(again.stdout, new RegExp(`review ${id}`));
  assert.equal(again.stderr, "");

  // --reset alone refuses because it would delete a proposal; nothing changes.
  const reset = demo("--dir", dir, "--reset");
  assert.equal(reset.status, 1);
  assert.match(reset.stderr, /--discard-proposals/);
  assert.ok(!/\n\s+at /.test(reset.stderr), "no stack trace for an expected refusal");
  assert.match(demo("--dir", dir).stdout, new RegExp(`proposal ${id}: pending`), "proposal survived the refused reset");

  const discard = demo("--dir", dir, "--reset", "--discard-proposals");
  assert.equal(discard.status, 0, discard.stderr);
  assert.ok(!discard.stdout.includes(id), "a fresh demo has a new proposal");
  await rm(base, { recursive: true, force: true });
});

test("demo refuses a non-empty folder that is not an earlier demo", async () => {
  const base = await tempDir("demo-refuse");
  const dir = path.join(base, "real-looking");
  await mkdir(dir);
  await writeFile(path.join(dir, "AGENTS.md"), "# Someone's real project\n");
  const r = demo("--dir", dir, "--reset");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not an Agentlore demo folder/);
  assert.equal(await readFile(path.join(dir, "AGENTS.md"), "utf8"), "# Someone's real project\n");
  await rm(base, { recursive: true, force: true });
});

test("doctor is non-destructive, reports workspace problems, and prints no environment values", async () => {
  const base = await tempDir("doctor");
  const doctor = (...args: string[]) =>
    spawnSync(process.execPath, [path.join(REPO, "scripts", "doctor.mjs"), "doctor", ...args, "--json"], {
      cwd: REPO, encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CURSOR_AGENT: "1", AGENTLORE_TEST_SECRET: "sk-DOCTORFAKEFAKEFAKEFAKE1234" },
    });
  const missing = path.join(base, "not-created");
  const r1 = doctor("--workspace", missing);
  assert.equal(r1.status, 0, r1.stderr);
  const report = JSON.parse(r1.stdout);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((c: { id: string; status: string }) => c.id === "dependencies" && c.status === "ok"));
  assert.ok(report.checks.some((c: { id: string; status: string; message: string }) => c.id === "terminal" && c.status === "warn" && /CURSOR_AGENT/.test(c.message)));
  assert.deepEqual(report.launch.mcpClientConfig.args.slice(-2), ["--workspace", missing]);
  assert.equal(existsSync(missing), false, "doctor never creates the workspace");
  assert.ok(!r1.stdout.includes("sk-DOCTORFAKE"), "environment values are never printed");

  const open = path.join(base, "too-open");
  await mkdir(open, { mode: 0o755 });
  await chmod(open, 0o755);
  const r2 = doctor("--workspace", open);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /chmod 700/);

  const linked = path.join(base, "linked");
  await symlink(open, linked);
  const r3 = doctor("--workspace", linked);
  assert.equal(r3.status, 1);
  assert.match(r3.stdout, /symlink/);
  await rm(base, { recursive: true, force: true });
});

test("a demo created before the rename (legacy .agentweave-demo marker) is recognized and kept", async () => {
  const base = await tempDir("demo-legacy");
  const dir = path.join(base, "old-demo");
  const first = demo("--dir", dir);
  assert.equal(first.status, 0, first.stderr);
  const id = /review (chg_[0-9a-f]{16})/.exec(first.stdout)?.[1];
  assert.ok(id);
  const { rename } = await import("node:fs/promises");
  await rename(path.join(dir, ".agentlore-demo"), path.join(dir, ".agentweave-demo"));
  const again = demo("--dir", dir);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already exists .* kept as is/);
  assert.match(again.stdout, new RegExp(`proposal ${id}: pending`));
  assert.ok(existsSync(path.join(dir, ".agentweave-demo")) && !existsSync(path.join(dir, ".agentlore-demo")), "the old marker is left alone");
  await rm(base, { recursive: true, force: true });
});
