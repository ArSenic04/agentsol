import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { proposeChange } from "../src/core/proposals.ts";
import { scanProject } from "../src/core/scan.ts";
import { detectTerm } from "../src/cli/tui.ts";
import { fixture, sourceByPath, tempDir } from "./helpers.ts";

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
    const log = run(ws2, "log");
    assert.equal(log.status, 0, log.stderr);
    assert.doesNotMatch(log.stdout, /show the audit log/, "log prints the audit log, not the usage text");
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

test("connect claude-desktop uses the full npx path when npx is outside the system folders", { skip: process.platform === "win32" }, async () => {
  const bin = await tempDir("bin");
  try {
    for (const b of ["npx", "node"]) { await writeFile(path.join(bin, b), "#!/bin/sh\n"); await chmod(path.join(bin, b), 0o755); }
    const run = (PATH: string): string => spawnSync(process.execPath, [CLI, "connect", "claude-desktop"], { cwd: REPO, encoding: "utf8", env: { PATH, HOME: bin, NO_COLOR: "1" } }).stdout;
    const custom = run(bin);
    assert.ok(custom.includes(`"command": "${path.join(bin, "npx")}"`), custom);
    assert.ok(custom.includes(`"PATH": "${bin}:/usr/bin:/bin"`), custom);
    assert.match(custom, /not in the app's connector directory/);
    const system = run("/usr/bin:/bin");
    assert.match(system, /"command": "npx"/);
    assert.doesNotMatch(system, /"PATH"/);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});

test("start registers, scans and connects only apps that are installed, after consent, never from an agent", async () => {
  const fx = await fixture({ "AGENTS.md": "# Rules\n\n- Keep changes small.\n" });
  const home = await mkdtemp(path.join(tmpdir(), "agentsol-home-"));
  try {
    const bin = path.join(home, "bin");
    await mkdir(bin);
    const claude = path.join(bin, "claude");
    await writeFile(claude, `#!/bin/sh\necho "$@" > "$HOME/claude-args"\necho '{"mcpServers":{"agentsol":{"command":"npx","args":["-y","-p","agentsol@alpha","agentsol-mcp"]}}}' > "$HOME/.claude.json"\n`);
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 1\n");
    await chmod(claude, 0o755);
    await chmod(path.join(bin, "codex"), 0o755);
    // PATH holds only the fakes, so no real assistant app can be reached.
    const start = (extra: Record<string, string>, ...args: string[]) =>
      spawnSync(process.execPath, [CLI, "start", ...args], { cwd: fx.root, encoding: "utf8", input: "", timeout: 30_000, env: { PATH: bin, HOME: home, AGENTSOL_WORKSPACE: path.join(home, "ws"), NO_COLOR: "1", ...extra } });

    const first = start({}, "--yes");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Project\s+registered /);
    assert.match(first.stdout, /Claude Code · connected now/);
    assert.match(first.stdout, /Codex · could not connect/);
    assert.match(first.stdout, /Restart your AI app/);
    assert.ok(!/Gemini|VS Code|Cursor/.test(first.stdout), "apps that are not installed are not listed");
    assert.match(await readFile(path.join(home, "claude-args"), "utf8"), /^mcp add agentsol -s user -e AGENTSOL_WORKSPACE=.* -- npx -y -p agentsol@alpha agentsol-mcp$/m);

    await rm(path.join(home, "claude-args"));
    const second = start({});
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Claude Code · connected\b(?! now)/);
    assert.match(second.stdout, /Codex · not connected/);
    assert.match(second.stdout, /codex mcp add agentsol/, "prints the command it did not run");
    assert.ok(!existsSync(path.join(home, "claude-args")), "an app that is already connected is not changed again");

    await rm(path.join(home, ".claude.json"));
    const agent = start({ CLAUDE_CODE_CHILD_SESSION: "1" }, "--yes");
    assert.equal(agent.status, 0, agent.stderr);
    assert.ok(!existsSync(path.join(home, "claude-args")), "an agent-run terminal never changes app config, even with --yes");
    assert.match(agent.stdout, /Claude Code runs this terminal, so nothing was connected/);
    assert.equal(await readFile(path.join(fx.root, "AGENTS.md"), "utf8"), "# Rules\n\n- Keep changes small.\n");
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("terminal width comes from the terminal, else COLUMNS (piped output), within 40 to 110", () => {
  assert.equal(detectTerm({ isTTY: true, columns: 70 }, { COLUMNS: "200" }).width, 70);
  assert.equal(detectTerm({}, { COLUMNS: "60" }).width, 60);
  assert.equal(detectTerm({}, { COLUMNS: "10" }).width, 40);
  assert.equal(detectTerm({}, { COLUMNS: "wide" }).width, 80);
  assert.equal(detectTerm({}, {}).width, 80);
  assert.equal(detectTerm({}, { COLUMNS: "500" }).width, 110);
  assert.deepEqual([detectTerm({}, {}).color, detectTerm({ isTTY: true }, { NO_COLOR: "1" }).color, detectTerm({ isTTY: true }, { TERM: "dumb" }).color, detectTerm({}, { FORCE_COLOR: "1" }).color], [false, false, false, true]);
});

test("check --sarif emits SARIF 2.1.0 that code scanning can place, without paths or secret values", async () => {
  const token = ["ghp", "_", "Q7".repeat(18)].join("");
  const fx = await fixture({
    "package.json": JSON.stringify({ name: "x", packageManager: "pnpm@9.0.0" }),
    "pnpm-lock.yaml": "",
    "AGENTS.md": `# Rules\n\n- Run \`npm test\` before you commit.\n- Deploy token: ${token}\n`,
    "skills/demo/SKILL.md": "---\nname: wrong\ndescription: d\n---\nbody\n",
  });
  try {
    const ws = path.join(path.dirname(fx.root), "ws-sarif");
    const r = run(ws, "check", "--sarif", fx.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(token), "secret value never appears");
    assert.ok(!r.stdout.includes(fx.root) && !r.stdout.includes(homedir()), "no absolute paths");
    const sarif = JSON.parse(r.stdout);
    assert.equal(sarif.version, "2.1.0");
    const [run0] = sarif.runs;
    const ruleIds = run0.tool.driver.rules.map((x: { id: string }) => x.id);
    assert.ok(ruleIds.includes("D16") && ruleIds.includes("S01"));
    for (const res of run0.results) {
      assert.equal(ruleIds[res.ruleIndex], res.ruleId);
      assert.ok(["error", "warning", "note"].includes(res.level));
      assert.match(res.partialFingerprints["agentsolFinding/v1"], /^[0-9a-f]{32}$/);
      for (const loc of res.locations) {
        assert.match(loc.physicalLocation.artifactLocation.uri, /^[^/\\][^\\]*$/, "relative, forward slashes");
        assert.ok(loc.physicalLocation.region.startLine >= 1);
      }
    }
    assert.deepEqual(new Set(run0.results.map((x: { ruleId: string }) => x.ruleId)), new Set(["D02", "D12", "D16"]));
    const strict = run(ws, "check", "--strict", "--sarif-file", path.join(fx.root, "out.sarif"), fx.root);
    assert.equal(strict.status, 1, "--strict still fails on errors");
    assert.match(strict.stdout, /agentsol check/, "--sarif-file keeps the normal report");
    assert.deepEqual(JSON.parse(await readFile(path.join(fx.root, "out.sarif"), "utf8")).runs[0].results.length, run0.results.length);
    assert.equal(run(ws, "check", "--sarif-file").status, 2);
  } finally {
    await fx.cleanup();
  }
});

test("SARIF uris are relative to the checkout when the checked folder is inside it", async () => {
  const { checkSarif } = await import("../src/core/sarif.ts");
  const f = { kind: "structural", id: "x", checkId: "D07", severity: "warn", title: "t", message: "m", docUrl: "", evidence: [{ sourceId: "s", versionId: "v", relPath: path.join("docs", "AGENTS.md"), startLine: 3, endLine: 2, textSha256: "0".repeat(64) }] } as never;
  const at = (root: string, base: string) => (checkSarif([f], root, base) as { runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string }; region: { endLine: number } } }[] }[] }[] }).runs[0]!.results[0]!.locations[0]!.physicalLocation;
  assert.equal(at("/ci/repo/pkg", "/ci/repo").artifactLocation.uri, "pkg/docs/AGENTS.md");
  assert.equal(at("/elsewhere", "/ci/repo").artifactLocation.uri, "docs/AGENTS.md");
  assert.equal(at("/ci/repo", "/ci/repo").region.endLine, 3);
});
