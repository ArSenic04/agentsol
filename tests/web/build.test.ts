import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const build = (out: string) => spawnSync(process.execPath, [path.join(REPO, "scripts/buildWeb.ts"), "--out", out], { cwd: REPO, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });

test("web build is static, self-contained, and carries no local paths or secrets", async () => {
  const base = await tempDir("webbuild");
  const out = path.join(base, "site");
  try {
    const r = build(out);
    assert.equal(r.status, 0, r.stderr);
    const files = (await readdir(out, { recursive: true })).sort();
    assert.deepEqual(files.filter((f) => !f.startsWith(".")), ["favicon.svg", "index.html", "js", "js/app.js", "js/checker.js", "js/contract.js", "js/core", "js/core/claudeImports.js", "js/core/handoff.js", "js/core/risks.js", "js/core/secrets.js", "js/data.js", "js/demo-data.js", "js/dom.js", "js/hero.js", "js/inspect.js", "js/labels.js", "js/landing.js", "js/mode.js", "js/setup.js", "js/workspace.js", "llms.txt", "og.png", "robots.txt", "styles.css"]);
    let all = "";
    for (const f of files) if (f.includes(".") && !f.endsWith(".png")) all += await readFile(path.join(out, f), "utf8");
    assert.ok(!all.includes(REPO) && !/\/(Users|private\/var|var\/folders)\//.test(all), "no absolute local paths");
    assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(all), "no sample secret");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(all), "no HTML injection sinks");
    assert.ok(!/https?:\/\/(?!arsenic04\.github\.io\/agentsol-site\/|www\.w3\.org\/2000\/svg|www\.npmjs\.com\/package\/agentsol|agentskills\.io\/specification|code\.claude\.com\/docs\/en\/memory|learn\.chatgpt\.com\/docs\/agent-configuration\/agents-md|127\.0\.0\.1)/.test(all), "no external URLs except fixed doc links");
    const html = await readFile(path.join(out, "index.html"), "utf8");
    assert.ok(!/<script>|<script(?![^>]*src=)[^>]*>|style=/.test(html), "no inline script or style (strict CSP)");
    const demo = await readFile(path.join(out, "js/demo-data.js"), "utf8");
    assert.match(demo, /REDACTED:api_key/);
    assert.match(demo, /assistant:demo-script/, "demo proposal is attributed to the script, not an AI");
    assert.ok(!demo.includes("/api/proposals/"), "no approval routes recorded");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("web build refuses to delete a folder that is not an earlier build", async () => {
  const base = await tempDir("webbuild-refuse");
  const out = path.join(base, "precious");
  try {
    await mkdir(out);
    await writeFile(path.join(out, "keep.txt"), "user file");
    const r = build(out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to delete/);
    assert.equal(await readFile(path.join(out, "keep.txt"), "utf8"), "user file");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("web build replaces an earlier build made before the rename (legacy marker)", async () => {
  const base = await tempDir("webbuild-legacy");
  const out = path.join(base, "site");
  try {
    await mkdir(out);
    await writeFile(path.join(out, ".agentweave-web-build"), "old build\n");
    await writeFile(path.join(out, "stale.js"), "// old");
    const r = build(out);
    assert.equal(r.status, 0, r.stderr);
    const files = await readdir(out);
    assert.ok(files.includes(".agentsol-web-build") && !files.includes("stale.js"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
