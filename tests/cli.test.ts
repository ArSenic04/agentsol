import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

test("CLI without a workspace flag uses <home>/.agentsol", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agentsol-home-"));
  try {
    const r = spawnSync(process.execPath, [CLI, "projects"], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(path.join(home, ".agentsol")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("check registers the folder, scans it and cites findings; prompt hands masked files to any AI", async () => {
  const fx = await fixture({
    "AGENTS.md": `# Root\n- Use npm to run scripts.\n- key: sk-FAKEFAKEFAKEFAKEFAKEFAKE1234567890\n`,
    "CLAUDE.md": "# Notes\n@docs/missing.md\n",
    "skills/notes/SKILL.md": "---\nname: Notes\n---\nBody\n",
  });
  try {
    const ws2 = path.join(path.dirname(fx.root), "ws-check");
    const c = runEnv({ NO_COLOR: "1" }, ws2, "check", fx.root);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /Registered/);
    assert.match(c.stdout, /D09 {2}CLAUDE\.md:2/);
    assert.match(c.stdout, /D02 {2}skills\/notes\/SKILL\.md:2/);
    assert.match(c.stdout, /D12/);
    assert.match(c.stdout, /nothing in your project was changed/);
    assert.ok(!c.stdout.includes("FAKEFAKE"), "secrets never printed");
    assert.ok(!c.stdout.includes("\x1b["), "no escape codes when not a terminal");
    const again = runEnv({}, ws2, "check", fx.root, "--json", "--strict");
    assert.equal(again.status, 1, "--strict fails on errors");
    const j = JSON.parse(again.stdout);
    assert.equal(j.registeredNow, false);
    assert.ok(j.findings.findings.some((f: { checkId: string }) => f.checkId === "D03"));
    const p = run(ws2, "prompt", fx.root);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /### AGENTS\.md/);
    assert.match(p.stdout, /\[D09\] CLAUDE\.md:2/);
    assert.match(p.stdout, /REDACTED/);
    assert.ok(!p.stdout.includes("FAKEFAKE"));
    assert.match(p.stderr, /prompt ready/);
  } finally {
    await fx.cleanup();
  }
});

test("check output cannot be hijacked by escape codes inside instruction files", async () => {
  const fx = await fixture({ "CLAUDE.md": "# Notes\n@docs/\u001b[31mevil\u001b]0;pwned\u0007.md\n" });
  try {
    const c = runEnv({ FORCE_COLOR: "1" }, path.join(path.dirname(fx.root), "ws-esc"), "check", fx.root);
    assert.equal(c.status, 0, c.stderr);
    assert.ok(!c.stdout.includes("\u001b[31mevil") && !c.stdout.includes("\u001b]0;") && !c.stdout.includes("\u0007"), "file text is escaped, only Agentsol styles output");
    assert.match(c.stdout, /\\u\{1b\}/);
  } finally {
    await fx.cleanup();
  }
});

test("connect prints setup for every client and adds the workspace only when it is not the default", () => {
  const custom = spawnSync(process.execPath, [CLI, "--workspace", "/tmp/custom-ws", "connect"], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: homedir() } });
  assert.equal(custom.status, 0, custom.stderr);
  for (const s of ["claude mcp add agentsol", "codex mcp add agentsol", "gemini mcp add", "code --add-mcp", "mcpServers", "prompt |"]) assert.ok(custom.stdout.includes(s), s);
  assert.match(custom.stdout, /AGENTSOL_WORKSPACE="\/tmp\/custom-ws"/);
  const plain = spawnSync(process.execPath, [CLI, "connect", "claude-code"], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: homedir() } });
  assert.match(plain.stdout, /claude mcp add agentsol -s user -- npx -y -p agentsol@alpha agentsol-mcp/);
  assert.ok(!plain.stdout.includes("AGENTSOL_WORKSPACE"));
  assert.equal(spawnSync(process.execPath, [CLI, "connect", "nope"], { cwd: REPO, encoding: "utf8" }).status, 2);
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
