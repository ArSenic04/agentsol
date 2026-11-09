import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { proposeChange } from "../src/core/proposals.ts";
import { scanProject } from "../src/core/scan.ts";
import { fixture, sourceByPath } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "src", "cli", "main.ts");
const run = (ws: string, ...args: string[]) => runEnv({}, ws, ...args);
const runEnv = (extra: Record<string, string>, ws: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, "--workspace", ws, ...args], { cwd: REPO, encoding: "utf8", input: "", timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: homedir(), ...extra } });

test("CLI registers a project, scans it, and refuses home or filesystem root", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n" });
  try {
    const ws2 = path.join(path.dirname(fx.root), "ws2");
    assert.equal(run(ws2, "project", "add", homedir()).status, 2);
    assert.equal(run(ws2, "project", "add", "/").status, 2);
    assert.equal(run(ws2, "project", "add", path.dirname(homedir())).status, 2, "a folder containing home is refused");
    assert.equal(run(ws2, "project", "add", ws2).status, 2);
    const add = run(ws2, "project", "add", fx.root, "--name", "demo");
    assert.equal(add.status, 0, add.stderr);
    const id = /registered (prj_[0-9a-f]{16})/.exec(add.stdout)?.[1];
    assert.ok(id);
    const scan = run(ws2, "scan", id);
    assert.equal(scan.status, 0, scan.stderr);
    assert.match(run(ws2, "sources", id).stdout, /AGENTS\.md/);
  } finally {
    await fx.cleanup();
  }
});

test("CLI requires an explicit workspace", () => {
  const r = spawnSync(process.execPath, [CLI, "projects"], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--workspace/);
});

test("CLI approve and apply refuse to run without an interactive terminal", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n- Use npm.\n" });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const r = proposeChange(fx.store, {
      projectId: fx.projectId, author: "assistant:test",
      input: { sourceId: source.id, baseVersionId: version.id, findingIds: [], rationale: "t", edits: [{ startLine: 2, endLine: 2, expectedText: "- Use npm.", replacementLines: ["- Use pnpm."] }] },
    });
    assert.ok(r.ok);
    const id = r.value.proposal.id;
    const review = run(fx.wsDir, "review", id);
    assert.equal(review.status, 0);
    assert.match(review.stdout, /fingerprint: [0-9a-f]{12}/);
    for (const cmd of ["approve", "apply"]) {
      const res = run(fx.wsDir, cmd, id);
      assert.equal(res.status, 2, cmd);
      assert.match(res.stderr, /interactive terminal/);
    }
    assert.equal(fx.store.listApprovals(id).length, 0);
    assert.equal(fx.store.getProposal(id)?.status, "pending");
  } finally {
    await fx.cleanup();
  }
});

test("CLI refuses approve, apply and reject when an agent environment is detected", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n" });
  try {
    for (const [k, v] of [["CLAUDE_CODE_CHILD_SESSION", "1"], ["CODEX_CI", "1"], ["CURSOR_AGENT", "1"], ["AI_AGENT", "some-agent"]] as const) {
      for (const cmd of ["approve", "apply", "reject"]) {
        const r = runEnv({ [k]: v }, fx.wsDir, cmd, "chg_0000000000000000");
        assert.equal(r.status, 2, `${cmd} with ${k}`);
        assert.match(r.stderr, new RegExp(k));
      }
    }
  } finally {
    await fx.cleanup();
  }
});

test("CLI review escapes terminal control and bidi characters from untrusted text", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n- Use npm.\u202e evil\n" });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const r = proposeChange(fx.store, {
      projectId: fx.projectId, author: "assistant:test",
      input: { sourceId: source.id, baseVersionId: version.id, findingIds: [], rationale: "ok\u001b[2J\u001b]52;c;ZmFrZQ==\u0007 hidden", edits: [{ startLine: 1, endLine: 1, expectedText: "# Root", replacementLines: ["# Root!"] }] },
    });
    assert.ok(r.ok);
    const review = run(fx.wsDir, "review", r.value.proposal.id);
    assert.equal(review.status, 0);
    assert.ok(!/[\u001b\u0007\u202e]/.test(review.stdout), "no raw control or bidi characters reach the terminal");
    assert.match(review.stdout, /\\u\{1b\}\[2J/);
    assert.match(review.stdout, /\\u\{202e\}/);
  } finally {
    await fx.cleanup();
  }
});

test("CLI refuses an existing workspace that other users can read", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n" });
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(fx.wsDir, 0o755);
    const r = run(fx.wsDir, "projects");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /chmod 700/);
    await chmod(fx.wsDir, 0o700);
  } finally {
    await fx.cleanup();
  }
});
