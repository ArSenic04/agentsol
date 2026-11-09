import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAssistantService } from "../../src/core/service/assistant.ts";
import { LOCAL_MODE_MODULE, startWebServer } from "../../src/web/server.ts";
import { tempDir, withoutTimes } from "../helpers.ts";
import { raw, seededFixture, tinyStatic } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("local bridge: loopback only, read-only, same results as the shared service, no paths", async () => {
  const fx = await seededFixture();
  const dist = await tinyStatic(path.join(path.dirname(fx.root), "dist"));
  const srv = await startWebServer({ store: fx.store, staticDir: dist, port: 0, onInternalError: () => {} });
  try {
    const addr = srv.server.address();
    assert.ok(addr && typeof addr === "object" && addr.address === "127.0.0.1", "bound to 127.0.0.1 only");
    const svc = createAssistantService(fx.store, { reporter: () => "x", onInternalError: () => {} });
    const st = await raw(srv.port, { path: "/api/status" });
    assert.equal(st.status, 200);
    assert.equal(st.headers["cache-control"], "no-store, private");
    assert.equal(st.headers["access-control-allow-origin"], undefined, "no CORS");
    assert.match(String(st.headers["content-security-policy"]), /default-src 'none'/);
    const expected = await svc.status();
    assert.ok(expected.ok);
    assert.deepEqual(withoutTimes(JSON.parse(st.body)), withoutTimes(expected.value));
    for (const p of ["sources", "findings", "freshness", "proposals"]) {
      const r = await raw(srv.port, { path: `/api/projects/${fx.projectId}/${p}` });
      assert.equal(r.status, 200, p);
      assert.ok(!r.body.includes(fx.root) && !r.body.includes(path.dirname(fx.root)), `${p} leaks no absolute path`);
    }
    const proposals = JSON.parse((await raw(srv.port, { path: `/api/projects/${fx.projectId}/proposals` })).body);
    assert.equal(proposals.proposals.length, 1);
    const stored = fx.store.listProposals(fx.projectId)[0];
    assert.ok(stored && !JSON.stringify(proposals).includes(stored.body.proposalSha256.slice(0, 16)), "the approval digest is never exposed");
    const health = JSON.parse((await raw(srv.port, { path: "/api/health" })).body);
    assert.deepEqual(health, { product: "agentlore", mode: "local", readOnly: true, apiVersion: 1 });
  } finally {
    await srv.close();
    await fx.cleanup();
  }
});

test("local bridge refuses hostile hosts, origins, methods, traversal and approval-like routes", async () => {
  const fx = await seededFixture();
  const dist = await tinyStatic(path.join(path.dirname(fx.root), "dist"));
  await writeFile(path.join(path.dirname(fx.root), "outside.txt"), "SECRET-OUTSIDE");
  await symlink(path.join(path.dirname(fx.root), "outside.txt"), path.join(dist, "linked.txt"));
  const srv = await startWebServer({ store: fx.store, staticDir: dist, port: 0, onInternalError: () => {} });
  const before = fx.store.listProposals(fx.projectId).map((p) => p.status);
  try {
    const port = srv.port;
    assert.equal((await raw(port, { path: "/api/status", headers: { Host: "evil.example" } })).status, 421, "DNS rebinding: wrong Host");
    assert.equal((await raw(port, { path: "/api/status", headers: { Host: `0.0.0.0:${port}` } })).status, 421);
    assert.equal((await raw(port, { path: "/api/status", headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await raw(port, { path: "/api/status", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await raw(port, { path: "/api/status", headers: { Origin: `http://localhost:${port}` } })).status, 200, "same origin allowed");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await raw(port, { method, path: `/api/projects/${fx.projectId}/proposals` });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers["access-control-allow-origin"], undefined);
      assert.equal(r.headers["access-control-allow-methods"], undefined);
    }
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/js/../../package.json", "//etc/passwd", "/linked.txt", "/js/%2e%2e%2f%2e%2e%2fpackage.json"]) {
      const r = await raw(port, { path: p });
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes("SECRET-OUTSIDE") && !r.body.includes('"name": "agentlore"'), `${p} serves nothing outside the build`);
    }
    const firstProposal = fx.store.listProposals(fx.projectId)[0];
    assert.ok(firstProposal);
    const proposalId = firstProposal.body.id;
    for (const p of [`/api/projects/${fx.projectId}/scan`, `/api/proposals/${proposalId}/approve`, `/api/proposals/${proposalId}/apply`, "/api/projects/add", "/api/exec", `/api/sources/${encodeURIComponent("../../etc/passwd")}`, "/api/files?path=/etc/passwd"]) {
      const r = await raw(port, { path: p });
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.ok(!/root:|\/Users\/|\/private\//.test(r.body), `${p} body is sanitized`);
    }
    assert.deepEqual(fx.store.listProposals(fx.projectId).map((p) => p.status), before, "nothing changed");
    assert.equal(fx.store.listApprovals(proposalId).length, 0);
  } finally {
    await srv.close();
    await fx.cleanup();
  }
});

test("local bridge sanitizes internal errors and the static-only mode has no API", async () => {
  const fx = await seededFixture();
  const dist = await tinyStatic(path.join(path.dirname(fx.root), "dist"));
  const sunk: string[] = [];
  const srv = await startWebServer({ store: fx.store, staticDir: dist, port: 0, onInternalError: (op) => sunk.push(op) });
  const staticOnly = await startWebServer({ store: null, staticDir: dist, port: 0 });
  try {
    const html = await raw(staticOnly.port, { path: "/" });
    assert.equal(html.status, 200);
    assert.match(String(html.headers["content-security-policy"]), /script-src 'self'/);
    assert.equal(html.headers["x-frame-options"], "DENY");
    const api = await raw(staticOnly.port, { path: "/api/status" });
    assert.equal(api.status, 404);
    assert.match(api.body, /static demo/);

    // Explicit mode: only a bridge with a workspace tells the page to call the API.
    const localMode = await raw(srv.port, { path: "/js/mode.js" });
    assert.equal(localMode.status, 200);
    assert.equal(localMode.body, LOCAL_MODE_MODULE);
    assert.match(String(localMode.headers["content-type"]), /^text\/javascript/);
    assert.match(String(localMode.headers["content-security-policy"]), /default-src 'none'/);
    assert.notEqual((await raw(staticOnly.port, { path: "/js/mode.js" })).body, LOCAL_MODE_MODULE);

    fx.store.close();
    const r = await raw(srv.port, { path: "/api/status" });
    assert.equal(r.status, 500);
    const body = JSON.parse(r.body);
    assert.equal(body.error.code, "internal_error");
    assert.ok(!/\/(Users|private|var)\/|\.ts:\d+|\bat\s/.test(r.body), r.body);
    assert.ok(sunk.length >= 1);
  } finally {
    await srv.close();
    await staticOnly.close();
    await rm(path.dirname(fx.root), { recursive: true, force: true });
  }
});

test("web entrypoint needs an existing workspace, never creates one, and has no --host", async () => {
  const base = await tempDir("webmain");
  const dist = await tinyStatic(path.join(base, "dist"));
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO, "src/web/main.ts"), "--dist", dist, "--port", "45123", ...args], { cwd: REPO, encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  try {
    assert.equal(run().status, 2);
    const missing = path.join(base, "nope");
    const r = run("--workspace", missing);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not exist/);
    assert.equal(existsSync(missing), false, "workspace was not created");
    await mkdir(path.join(base, "empty"), { mode: 0o700 });
    const notWs = run("--workspace", path.join(base, "empty"));
    assert.equal(notWs.status, 2);
    assert.match(notWs.stderr, /not an Agentlore workspace/);
    assert.equal(existsSync(path.join(base, "empty", "workspace.sqlite")), false);
    const host = run("--static-only", "--host", "0.0.0.0");
    assert.equal(host.status, 2);
    assert.match(host.stderr, /no --host option/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
