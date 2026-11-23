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
  const registry = JSON.parse(readFileSync(path.join(REPO, "server.json"), "utf8"));
  assert.equal(registry.name, pkg.mcpName, "the MCP Registry checks this against the published package");
  assert.equal(registry.version, PRODUCT_VERSION);
  assert.ok(registry.packages.every((p: { version: string }) => p.version === PRODUCT_VERSION));
  assert.match(PRODUCT_VERSION, /^\d+\.\d+\.\d+-alpha\.\d+$/, "an explicit prerelease, not a stable version");
  const r = spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^agentsol ${PRODUCT_VERSION.replace(/\./g, "\\.")} \\(early alpha`));
  assert.match(readFileSync(path.join(REPO, "src/mcp/server.ts"), "utf8"), /version: PRODUCT_VERSION/);
  const action = readFileSync(path.join(REPO, "action.yml"), "utf8");
  assert.equal(/\n  version:\n(?: {4}.*\n)*? {4}default: "([^"]+)"/.exec(action)?.[1], PRODUCT_VERSION, "the GitHub Action runs the exact release it ships with");
});

test("package metadata stays release-safe until a person decides", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.name, "agentsol");
  assert.deepEqual(pkg.bin, { agentsol: "bin/agentsol.mjs", "agentsol-mcp": "bin/agentsol-mcp.mjs" });
  assert.equal(pkg.publishConfig?.tag, "alpha", "a publish without --tag still goes to alpha, never latest");
  for (const s of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[s], undefined, s);
});
