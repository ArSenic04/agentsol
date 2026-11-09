import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION } from "../src/core/version.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("one version everywhere: package.json, lockfile, CLI --version and the MCP server", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, PRODUCT_VERSION);
  assert.equal(lock.version, PRODUCT_VERSION);
  assert.equal(lock.packages[""].version, PRODUCT_VERSION);
  assert.match(PRODUCT_VERSION, /^\d+\.\d+\.\d+-alpha\.\d+$/, "an explicit prerelease, not a stable version");
  const r = spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^agentlore ${PRODUCT_VERSION.replace(/\./g, "\\.")} \\(early alpha`));
  assert.match(readFileSync(path.join(REPO, "src/mcp/server.ts"), "utf8"), /version: PRODUCT_VERSION/);
});

test("package metadata stays release-safe until a person decides", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.name, "agentlore");
  assert.deepEqual(pkg.bin, { agentlore: "bin/agentlore.mjs", "agentlore-mcp": "bin/agentlore-mcp.mjs" });
  assert.equal(pkg.publishConfig?.tag, "alpha", "a publish without --tag still goes to alpha, never latest");
  for (const s of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[s], undefined, s);
});
