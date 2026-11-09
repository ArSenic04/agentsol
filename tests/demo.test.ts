import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

  const again = demo("--dir", dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--reset/);
  assert.equal(demo("--dir", dir, "--reset").status, 0);
});

test("demo refuses a non-empty folder that is not an earlier demo", async () => {
  const base = await tempDir("demo-refuse");
  const dir = path.join(base, "real-looking");
  await mkdir(dir);
  await writeFile(path.join(dir, "AGENTS.md"), "# Someone's real project\n");
  const r = demo("--dir", dir, "--reset");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not an AgentWeave demo folder/);
  assert.equal(await readFile(path.join(dir, "AGENTS.md"), "utf8"), "# Someone's real project\n");
});
