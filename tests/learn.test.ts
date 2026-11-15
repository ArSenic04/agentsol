import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { learnLessons, lessonsChange, lessonsEdit, LESSONS_HEADING, mainCommand, readsFile, ruleFromCorrection, saidConflicts, codexFileIn } from "../src/core/learn.ts";
import { canonicalPath, programName } from "../src/core/sessions.ts";
import { fixture, tempDir, writeTree } from "./helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = `sk-${randomBytes(24).toString("hex")}`;

/** A Claude Code transcript where the agent repeats this project's usual mistakes. */
function session(cwd: string, startMs: number, opts: { said: string[]; fragile: boolean }): string {
  let t = startMs;
  const at = (): string => new Date((t += 20_000)).toISOString();
  const lines: unknown[] = [{ type: "user", cwd, timestamp: at(), message: { role: "user", content: "Add a parser for the config file" } }];
  let i = 0;
  const tool = (name: string, input: Record<string, unknown>, error = false): void => {
    i += 1;
    const id = `toolu_${i}`;
    lines.push({ type: "assistant", cwd, timestamp: at(), message: { id: `msg_${i}`, model: "fake-model-1", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "tool_use", id, name, input }] } });
    lines.push({ type: "user", cwd, timestamp: at(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: error ? "failed" : "ok" }] } });
  };
  const say = (text: string): void => { lines.push({ type: "user", cwd, timestamp: at(), message: { role: "user", content: text } }); };
  tool("Bash", { command: "cd app && npm test 2>&1 | tail -20" }, true);
  tool("Bash", { command: "npm test" }, true);
  tool("Bash", { command: "pnpm test" });
  for (const s of opts.said) say(s);
  tool("Bash", { command: "git fetch origin" }, true);
  tool("Bash", { command: "git fetch origin" });
  tool("Bash", { command: `deploy-tool --token ${FAKE}` }, true);
  if (opts.fragile) {
    const f = path.join(cwd, "src/parser.ts");
    tool("Edit", { file_path: f, old_string: "a", new_string: "b" });
    tool("Bash", { command: "pnpm test" }, true);
    tool("Edit", { file_path: f, old_string: "b", new_string: "c" });
    tool("Bash", { command: "pnpm test" }, true);
    tool("Edit", { file_path: f, old_string: "c", new_string: "d" });
    tool("Bash", { command: "pnpm run typecheck" });
  }
  tool("Bash", { command: "make release" }, true);
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("learn turns repeated mistakes into cited rules, and ignores plain retries", async () => {
  const fx = await fixture({ "AGENTS.md": "# Rules\n\n- Keep changes small.\n" });
  const home = await tempDir("home");
  try {
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, {
      ".claude/projects/-p/aaaa.jsonl": session(fx.root, T, { said: ["no, use pnpm not npm in this repo", "never edit the generated files in gen/", `stop, the key is ${FAKE}`], fragile: true }),
      ".claude/projects/-p/bbbb.jsonl": session(fx.root, T + 86_400_000, { said: ["Use pnpm, not npm, in this repo please", "don't edit the generated files in gen/ again"], fragile: true }),
      ".claude/projects/-p/cccc.jsonl": session(fx.root, T + 2 * 86_400_000, { said: [], fragile: false }),
    });
    const r = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0), instructionText: "# Rules\n\n- Keep changes small.\n" });
    assert.equal(r.sessionsRead, 3);
    const kinds = (k: string) => r.lessons.filter((l) => l.kind === k);

    const cmd = kinds("command");
    assert.equal(cmd.length, 1, JSON.stringify(cmd));
    assert.match(cmd[0]!.rule ?? "", /Use `pnpm`, not `npm`/);
    assert.equal(cmd[0]!.times, 3);
    assert.ok(cmd[0]!.lostMs > 0 && cmd[0]!.lostTokens > 0);
    assert.ok(cmd[0]!.evidence.every((e) => /^claude-[0-9a-f]+$/.test(e.sessionId) && typeof e.step === "number"));

    assert.ok(!kinds("correction").some((l) => l.title.includes("pnpm")), "a correction that repeats a command lesson is merged into it");
    assert.match(cmd[0]!.title, /You also told agents this yourself in 2 sessions/);

    const said = kinds("correction");
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.equal(said[0]!.sessions, 2);
    assert.equal(said[0]!.rule, "Never edit the generated files in gen/.");
    const fragile = kinds("fragile");
    assert.equal(fragile.length, 1);
    assert.match(fragile[0]!.rule ?? "", /`src\/parser\.ts`.*`pnpm run typecheck`/);

    const failing = kinds("failing");
    assert.ok(failing.some((l) => l.title.includes("make release") && l.rule === null), "a command that never worked asks the person");
    assert.ok(!failing.some((l) => l.title.includes("`pnpm test`")), "a command that works elsewhere is not 'never fixed'");
    assert.ok(!JSON.stringify(r).includes("git fetch"), "a retry that worked is not a lesson");
    assert.ok(!JSON.stringify(r).includes(FAKE), "secrets never appear");
    assert.ok(!JSON.stringify(r).includes(home), "no home paths");
    assert.ok(r.lostMs > 0 && r.agentMs >= r.lostMs);

    const covered = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0), instructionText: "- Always use pnpm, not npm, in this repo.\n" });
    assert.ok(!covered.lessons.find((l) => l.kind === "correction")?.alreadyInFile);
    assert.ok(covered.lessons.find((l) => l.kind === "command")?.alreadyInFile);
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("lesson helpers", () => {
  assert.deepEqual(mainCommand("cd web && npm run build 2>&1 | tail -5"), ["npm", "run", "build"]);
  assert.equal(mainCommand("echo hi"), null);
  assert.equal(ruleFromCorrection("no, always run the linter"), "Always run the linter.");
  const add = lessonsEdit(["# Rules", "", "- one", ""], ["Use `pnpm`."]);
  assert.deepEqual(add, { startLine: 3, endLine: 3, expectedText: "- one", replacementLines: ["- one", "", LESSONS_HEADING, "", add!.replacementLines[4]!, "", "- Use `pnpm`."] });
  const more = lessonsEdit(["# Rules", LESSONS_HEADING, "", "- old", "", "## Other", "x"], ["New."]);
  assert.deepEqual(more, { startLine: 4, endLine: 4, expectedText: "- old", replacementLines: ["- old", "- New."] });
});

test("agentsol learn --propose turns lessons into a proposal and changes no file", async () => {
  const fx = await fixture({ "AGENTS.md": "# Rules\n\n- Keep changes small.\n", "CLAUDE.md": "# Claude\n" });
  const home = await tempDir("home");
  try {
    const T = Date.now() - 3 * 86_400_000;
    await writeTree(home, {
      ".claude/projects/-p/aaaa.jsonl": session(fx.root, T, { said: ["no, use pnpm not npm in this repo"], fragile: true }),
      ".claude/projects/-p/bbbb.jsonl": session(fx.root, T + 3_600_000, { said: ["use pnpm, not npm, in this repo"], fragile: true }),
    });
    const env = { ...process.env, HOME: home, AGENTSOL_WORKSPACE: path.join(home, "ws"), NO_COLOR: "1" };
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), ...a], { env, encoding: "utf8", cwd: fx.root });
    const human = cli("learn");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /What repeated mistakes cost/);
    assert.match(human.stdout, /Use `pnpm`, not `npm`/);
    assert.match(human.stdout, /learn --propose/);
    assert.match(human.stdout, /@AGENTS\.md/, "warns that CLAUDE.md does not import AGENTS.md");
    const r = cli("learn", "--propose", "--json");
    assert.equal(r.status, 0, r.stderr);
    const v = JSON.parse(r.stdout) as { proposalId: string | null; suggestedChange: { edits: { replacementLines: string[] }[] } | null };
    assert.ok(v.proposalId, "a proposal was created");
    assert.ok(v.suggestedChange?.edits[0]?.replacementLines.some((l) => l.includes("pnpm")));
    assert.equal(await readFile(path.join(fx.root, "AGENTS.md"), "utf8"), "# Rules\n\n- Keep changes small.\n", "nothing written until a person applies it");
    const review = cli("review", v.proposalId!);
    assert.match(review.stdout, /\+## Lessons from past agent sessions/);
    assert.ok(!(human.stdout + r.stdout + review.stdout).includes(FAKE));
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

/** A Codex rollout with the same habits: npm fails, pnpm works, and the person corrects it. */
function codexSession(cwd: string, startMs: number): string {
  let t = startMs;
  const at = (): string => new Date((t += 20_000)).toISOString();
  const lines: unknown[] = [{ timestamp: at(), type: "session_meta", payload: { cwd, timestamp: at() } }, { timestamp: at(), type: "turn_context", payload: { cwd, model: "fake-codex" } }];
  let i = 0;
  const shell = (cmd: string, exit: number): void => {
    i += 1;
    lines.push({ timestamp: at(), type: "response_item", payload: { type: "function_call", name: "shell", call_id: `c${i}`, arguments: JSON.stringify({ command: ["bash", "-lc", cmd] }) } });
    lines.push({ timestamp: at(), type: "response_item", payload: { type: "function_call_output", call_id: `c${i}`, output: JSON.stringify({ output: "", metadata: { exit_code: exit } }) } });
  };
  lines.push({ timestamp: at(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>ignored</environment_context>" }] } });
  shell("npm test", 1);
  shell("pnpm test", 0);
  lines.push({ timestamp: at(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "never edit the generated files in gen/, regenerate them" }] } });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("learn combines Claude Code and Codex sessions into the same lessons", async () => {
  const fx = await fixture({ "AGENTS.md": "# Rules\n" });
  const home = await tempDir("home");
  try {
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, {
      ".claude/projects/-p/aaaa.jsonl": session(fx.root, T, { said: ["don't edit the generated files in gen/"], fragile: false }),
      ".codex/sessions/2026/11/02/rollout-2026-11-02T10-00-00-fake.jsonl": codexSession(fx.root, T + 86_400_000),
    });
    const r = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0) });
    assert.equal(r.sessionsRead, 2);
    const cmd = r.lessons.find((l) => l.kind === "command");
    assert.equal(cmd?.sessions, 2, JSON.stringify(r.lessons));
    assert.ok(cmd?.evidence.some((e) => e.sessionId.startsWith("codex-")) && cmd.evidence.some((e) => e.sessionId.startsWith("claude-")));
    const said = r.lessons.find((l) => l.kind === "correction");
    assert.equal(said?.sessions, 2, "a correction typed in Claude Code and in Codex counts as repeated");
    assert.ok(!JSON.stringify(r).includes("environment_context"));
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

type Cmd = [command: string, failed: boolean];
/** A Claude Code transcript that runs these commands in order. */
function claudeRun(cwd: string, startMs: number, cmds: readonly Cmd[]): string {
  let t = startMs;
  const at = (): string => new Date((t += 20_000)).toISOString();
  const lines: unknown[] = [{ type: "user", cwd, timestamp: at(), message: { role: "user", content: "go" } }];
  cmds.forEach(([command, failed], i) => {
    lines.push({ type: "assistant", cwd, timestamp: at(), message: { id: `m${i}`, usage: { input_tokens: 500, output_tokens: 50 }, content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] } });
    lines.push({ type: "user", cwd, timestamp: at(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: failed, content: failed ? "Exit code 1" : "ok" }] } });
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
function codexRun(cwd: string, startMs: number, cmds: readonly Cmd[]): string {
  let t = startMs;
  const at = (): string => new Date((t += 20_000)).toISOString();
  const lines: unknown[] = [{ timestamp: at(), type: "session_meta", payload: { cwd, timestamp: at() } }];
  cmds.forEach(([cmd, failed], i) => {
    lines.push({ timestamp: at(), type: "response_item", payload: { type: "function_call", name: "shell", call_id: `c${i}`, arguments: JSON.stringify({ command: ["bash", "-lc", cmd] }) } });
    lines.push({ timestamp: at(), type: "response_item", payload: { type: "function_call_output", call_id: `c${i}`, output: JSON.stringify({ output: "", metadata: { exit_code: failed ? 1 : 0 } }) } });
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("learn finds the instruction lines that cause the mistake and corrects them in place", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, {
      ".claude/projects/-p/a.jsonl": claudeRun(fx.root, T, [["npm install", true], ["pnpm install", false], ["pytest -q", true], ["python -m pytest -q", false]]),
      ".claude/projects/-p/b.jsonl": claudeRun(fx.root, T + 3_600_000, [["pytest", true], ["python -m pytest", false]]),
      ".codex/sessions/2026/11/01/rollout-2026-11-01T12-00-00-x.jsonl": codexRun(fx.root, T + 7_200_000, [["npm test", true], ["pnpm test", false]]),
    });
    const agents = [
      "# Rules", "",
      "- Install with `npm install`, then run `npm test`.",
      "- Do not use npm publish; releases go through CI.",
      "- Write pytest fixtures in conftest.py.",
      "- We publish to the npm registry.",
      "```sh", "pytest -q", "```",
      "- Before you commit, run pytest.",
      "- In CI it runs as `uv run pytest -x`.",
    ];
    const claudeMd = ["# Claude", "", "Build with `npm run build`."];
    const files = [{ relPath: "AGENTS.md", lines: agents }, { relPath: "CLAUDE.md", lines: claudeMd }];
    const r = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0), files, target: "AGENTS.md" });
    const npm = r.lessons.find((l) => l.rule?.includes("`pnpm`"));
    const py = r.lessons.find((l) => l.rule?.includes("python -m pytest"));
    assert.ok(npm && py, JSON.stringify(r.lessons.map((l) => l.rule)));
    assert.deepEqual(npm.clients, ["claude-code", "codex"]);
    assert.deepEqual(npm.conflicts.map((c) => [c.file, c.line, c.replacement]), [
      ["AGENTS.md", 3, "- Install with `pnpm install`, then run `pnpm test`."],
      ["CLAUDE.md", 3, "Build with `pnpm run build`."],
    ], "negated advice and prose about the registry are left alone");
    assert.deepEqual(py.conflicts.map((c) => [c.line, c.replacement]), [[8, "python -m pytest -q"], [10, "- Before you commit, run python -m pytest."]], "a bare word is a command only in code or after run");
    assert.match(npm.title, /^Your instructions tell agents to do this \(AGENTS\.md:3, CLAUDE\.md:3\)/);

    const change = lessonsChange(files[0]!, r.lessons);
    assert.equal(change.fixed, 3);
    assert.deepEqual(change.added, [], "a corrected line replaces the rule it would have added");
    assert.deepEqual(change.edits.map((e) => [e.startLine, e.expectedText]), [[3, agents[2]], [8, "pytest -q"], [10, agents[9]]]);
    const other = lessonsChange(files[1]!, r.lessons.map((l) => ({ ...l, rule: null })));
    assert.deepEqual(other.edits, [{ startLine: 3, endLine: 3, expectedText: "Build with `npm run build`.", replacementLines: ["Build with `pnpm run build`."] }]);

    const masked = lessonsChange({ relPath: "AGENTS.md", lines: agents, redacted: [3] }, r.lessons);
    assert.ok(!masked.edits.some((e) => e.startLine === 3), "a masked line is never rewritten");
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("a repeated correction that contradicts a written rule corrects that line instead of adding a rule", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, {
      ".claude/projects/-p/a.jsonl": session(fx.root, T, { said: ["no, don't use the staging database, use the local postgres", "never edit the generated files in gen/, run pnpm codegen"], fragile: false }),
      ".claude/projects/-p/b.jsonl": session(fx.root, T + 86_400_000, { said: ["don't use the staging database, use local postgres", "stop, never edit generated files in gen/ - run pnpm codegen"], fragile: false }),
    });
    const agents = [
      "# Rules", "",
      "- Use the staging database for integration tests.",
      "- Edit the generated files in gen/ when the API changes.",
      "- Keep the staging credentials out of git.",
      "- Do not edit gen/ by hand.",
      "```sh", "edit gen/ generated files", "```",
    ];
    const files = [{ relPath: "AGENTS.md", lines: agents }];
    const r = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0), files, target: "AGENTS.md" });
    const said = r.lessons.filter((l) => l.kind === "correction");
    assert.deepEqual(said.map((l) => l.conflicts.map((c) => c.line)).sort(), [[3], [4]], JSON.stringify(said.map((l) => [l.rule, l.conflicts])));
    for (const l of said) {
      assert.equal(l.conflicts[0]!.replacement, `- ${l.rule}`);
      assert.deepEqual(l.coveredIn, [], "a line that says the opposite does not cover the correction");
    }
    const change = lessonsChange(files[0]!, said);
    assert.equal(change.fixed, 2);
    assert.deepEqual(change.added, []);
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("a correction contradicts only lines that order the opposite, in the same scope", () => {
  const lines = ["- Use the staging database for integration tests.", "- Run yarn install, then yarn build.", "- We migrated off yarn in 2025.", "- Mock the network in unit tests.", "- Use npm for scripts."];
  const f = [{ relPath: "AGENTS.md", lines }];
  const at = (rule: string): number[] => saidConflicts(rule, f).map((c) => c.line);
  assert.deepEqual(at("Never use yarn."), [2], "prose that mentions yarn is not an order");
  assert.deepEqual(at("Use local postgres instead of the staging database."), [1]);
  assert.deepEqual(at("Use pnpm, not npm, in this repo."), [5]);
  assert.deepEqual(at("Don't mock the network in integration tests."), [], "unit tests are a different scope");
  assert.deepEqual(at("Keep changes small."), []);
});

test("Codex reads a non-empty AGENTS.override.md instead of AGENTS.md in the same folder", () => {
  const files = [
    { relPath: "AGENTS.md", lines: ["- Use pnpm."] },
    { relPath: "AGENTS.override.md", lines: ["- Keep diffs small."] },
    { relPath: "CLAUDE.md", lines: ["@AGENTS.md"] },
    { relPath: "pkg/AGENTS.md", lines: ["- Run make."] },
    { relPath: "pkg/AGENTS.override.md", lines: ["", "  "] },
  ];
  assert.equal(codexFileIn("", files), "AGENTS.override.md");
  assert.equal(codexFileIn("pkg/", files), "pkg/AGENTS.md", "an empty override is skipped");
  assert.equal(readsFile("codex", "AGENTS.md", files), false);
  assert.equal(readsFile("codex", "AGENTS.override.md", files), true);
  assert.equal(readsFile("codex", "pkg/AGENTS.md", files), true);
  assert.equal(readsFile("claude-code", "AGENTS.md", files), true);
  assert.equal(readsFile("claude-code", "AGENTS.override.md", files), false, "@AGENTS.md does not import the override");
  assert.equal(readsFile("claude-code", "AGENTS.override.md", [...files.slice(0, 2), { relPath: "CLAUDE.md", lines: ["@AGENTS.override.md"] }]), true);
});

test("learn says why a written rule did not help: the app that made the mistake does not read that file", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, {
      ".codex/sessions/2026/11/01/rollout-2026-11-01T10-00-00-a.jsonl": codexRun(fx.root, T, [["npm test", true], ["pnpm test", false]]),
      ".codex/sessions/2026/11/02/rollout-2026-11-02T10-00-00-b.jsonl": codexRun(fx.root, T + 86_400_000, [["npm test", true], ["pnpm test", false]]),
    });
    const inClaude = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0), target: "CLAUDE.md", files: [{ relPath: "CLAUDE.md", lines: ["- Always use pnpm here."] }] });
    const l = inClaude.lessons.find((x) => x.kind === "command");
    assert.ok(l?.alreadyInFile);
    assert.deepEqual(l.coveredIn, ["CLAUDE.md"]);
    assert.match(l.why ?? "", /Codex made this mistake and does not read it\. Codex reads AGENTS\.md/);
    const inAgents = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0), target: "AGENTS.md", files: [{ relPath: "AGENTS.md", lines: ["- Always use pnpm here."] }] });
    assert.match(inAgents.lessons.find((x) => x.kind === "command")?.why ?? "", /had this rule in AGENTS\.md and repeated the mistake anyway\. Make it more specific/);
    assert.ok(readsFile("claude-code", "AGENTS.md", [{ relPath: "CLAUDE.md", lines: ["@AGENTS.md"] }]));
    assert.ok(!readsFile("claude-code", "AGENTS.md", [{ relPath: "CLAUDE.md", lines: ["see AGENTS.md"] }]));
    assert.ok(readsFile("codex", "services/api/AGENTS.md", []) && !readsFile("codex", "CLAUDE.md", []));
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("learn works through symlinked folders and with Windows command names", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const link = path.join(home, "code-link");
    await symlink(fx.root, link);
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, {
      ".claude/projects/-p/a.jsonl": claudeRun(link, T, [["npm test", true], ["pnpm test", false]]),
      ".claude/projects/-p/b.jsonl": claudeRun(fx.root, T + 3_600_000, [["C:/nodejs/NPM.CMD test", true], ["pnpm.cmd test", false], ["$env:CI=1; npm run build", true], ["timeout 60 pnpm run build", false]]),
    });
    const r = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0) });
    assert.equal(r.sessionsRead, 2, "a session started through a symlink belongs to the project");
    const cmd = r.lessons.filter((l) => l.kind === "command");
    assert.equal(cmd.length, 1, JSON.stringify(cmd.map((l) => l.rule)));
    assert.equal(cmd[0]!.times, 3);
    assert.match(cmd[0]!.rule ?? "", /^Use `pnpm`, not `npm`/);
    assert.equal(programName("C:\\Program Files\\nodejs\\npm.cmd"), "npm");
    assert.equal(programName("./node_modules/.bin/vitest"), "vitest");
    assert.equal(canonicalPath(path.join(link, "gone", "x.ts")), path.join(fx.root, "gone", "x.ts"));
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("agentsol learn --propose corrects every file that is wrong; with no file it picks the one the app reads", async () => {
  const fx = await fixture({ "AGENTS.md": "# Rules\n\n- Run `npm test` before you commit.\n", "CLAUDE.md": "@AGENTS.md\n\nBuild with `npm run build`.\n" });
  const bare = await fixture({});
  const home = await tempDir("home");
  try {
    const T = Date.now() - 2 * 86_400_000;
    await writeTree(home, {
      ".claude/projects/-p/a.jsonl": claudeRun(fx.root, T, [["npm test", true], ["pnpm test", false], ["npm run build", true], ["pnpm run build", false]]),
      ".claude/projects/-q/b.jsonl": claudeRun(bare.root, T, [["npm test", true], ["pnpm test", false]]),
      ".claude/projects/-q/c.jsonl": claudeRun(bare.root, T + 60_000, [["npm test", true], ["pnpm test", false]]),
    });
    const env = { ...process.env, HOME: home, AGENTSOL_WORKSPACE: path.join(home, "ws"), NO_COLOR: "1" };
    const cli = (cwd: string, ...a: string[]) => spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), ...a], { env, encoding: "utf8", cwd });
    const human = cli(fx.root, "learn");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /1 wrong instruction|2 wrong instructions/);
    assert.match(human.stdout, /now {3}− - Run `npm test` before you commit\.[\s\S]*fix {3}\+ - Run `pnpm test` before you commit\./);
    assert.ok(!/does not import AGENTS\.md/.test(human.stdout), "CLAUDE.md imports AGENTS.md, so no warning");
    const r = cli(fx.root, "learn", "--propose", "--json");
    const v = JSON.parse(r.stdout) as { proposals: { relPath: string; proposalId: string }[]; otherChanges: unknown[] };
    assert.deepEqual(v.proposals.map((p) => p.relPath), ["AGENTS.md", "CLAUDE.md"]);
    const again = JSON.parse(cli(fx.root, "learn", "--propose", "--json").stdout) as typeof v;
    assert.deepEqual(again.proposals.map((p) => p.proposalId), v.proposals.map((p) => p.proposalId), "running it again does not pile up copies");
    assert.match(cli(fx.root, "learn", "--propose").stdout, /\(already waiting\)/);
    assert.match(cli(fx.root, "review", v.proposals[1]!.proposalId).stdout, /-Build with `npm run build`\.\n\+Build with `pnpm run build`\./);
    assert.equal(await readFile(path.join(fx.root, "AGENTS.md"), "utf8"), "# Rules\n\n- Run `npm test` before you commit.\n", "nothing written until a person applies it");

    const none = cli(bare.root, "learn", "--json");
    const n = JSON.parse(none.stdout) as { newFile: string | null; newFileText: string | null };
    assert.equal(n.newFile, "CLAUDE.md", "only Claude Code ran here, so the rules go where it reads them");
    assert.match(n.newFileText ?? "", /- Use `pnpm`, not `npm`/);
  } finally {
    await fx.cleanup();
    await bare.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("learn in a monorepo corrects the nested AGENTS.md that caused the mistake, without a second rule at the root", async () => {
  const fx = await fixture({
    "AGENTS.md": "# Monorepo\n\n- Install Python deps with `pip install -r requirements.txt`.\n- Use pip only inside the venv.\n",
    "packages/web/AGENTS.md": "# Web\n\n- Run `yarn test` and `yarn lint` before you push.\n",
  });
  const home = await tempDir("home");
  try {
    const web = path.join(fx.root, "packages/web");
    const T = Date.now() - 2 * 86_400_000;
    await writeTree(home, {
      ".claude/projects/-p/a.jsonl": claudeRun(web, T, [["yarn test", true], ["bun test", false], ["cd ../.. && pip install -r requirements.txt", true], ["uv pip install -r requirements.txt", false]]),
      ".claude/projects/-p/b.jsonl": claudeRun(web, T + 60_000, [["yarn lint", true], ["bun lint", false], ["pip install -r requirements.txt", true], ["uv pip install -r requirements.txt", false]]),
    });
    const env = { ...process.env, HOME: home, AGENTSOL_WORKSPACE: path.join(home, "ws"), NO_COLOR: "1", COLUMNS: "100" };
    const r = spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), "learn", "--json"], { env, encoding: "utf8", cwd: fx.root });
    const v = JSON.parse(r.stdout) as { lessons: { conflicts: { file: string; line: number; replacement: string }[] }[]; suggestedChange: { edits: { startLine: number; replacementLines: string[] }[] } | null; otherChanges: { relPath: string; edits: { replacementLines: string[] }[] }[] };
    const conflicts = v.lessons.flatMap((l) => l.conflicts).map((c) => [c.file, c.line, c.replacement]).sort();
    assert.deepEqual(conflicts, [
      ["AGENTS.md", 3, "- Install Python deps with `uv pip install -r requirements.txt`."],
      ["packages/web/AGENTS.md", 3, "- Run `bun test` and `bun lint` before you push."],
    ], "prose that mentions pip without running it is left alone");
    assert.deepEqual(v.suggestedChange?.edits.map((e) => e.startLine), [3], "the root only gets its own correction, no extra bun rule");
    assert.deepEqual(v.otherChanges.map((c) => c.relPath), ["packages/web/AGENTS.md"]);
    const human = spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), "learn"], { env, encoding: "utf8", cwd: fx.root }).stdout;
    assert.match(human, /2 corrections in AGENTS\.md, packages\/web\/AGENTS\.md:\s*│\n\s*│\s+agentsol learn --propose/, "a long file list puts the command on its own line instead of cutting it off");
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("learn reads newer Codex transcripts and CRLF instruction files, and the review diff merges nearby edits", async () => {
  const fx = await fixture({ "AGENTS.md": "# Rules\r\n\r\n- Run `npm test` before you commit.\r\n- Format with `npm run fmt`.\r\n" });
  const home = await tempDir("home");
  try {
    const T = Date.now() - 2 * 86_400_000;
    let t = T;
    const at = (): string => new Date((t += 20_000)).toISOString();
    const rollout = (how: "text" | "event", cmds: [string, number][]): string => [
      { timestamp: at(), type: "session_meta", payload: { cwd: fx.root, timestamp: at() } },
      ...cmds.flatMap(([cmd, code], i) => [
        { timestamp: at(), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `c${i}`, arguments: JSON.stringify({ cmd, workdir: fx.root }) } },
        ...(how === "event" ? [{ timestamp: at(), type: "event_msg", payload: { type: "exec_command_end", call_id: `c${i}`, exit_code: code } }] : []),
        { timestamp: at(), type: "response_item", payload: { type: "function_call_output", call_id: `c${i}`, output: how === "text" ? `Wall time: 1.0 seconds\nProcess exited with code ${code}\nOutput:\n` : "done" } },
      ]),
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
    await writeTree(home, {
      ".codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-a.jsonl": rollout("text", [["npm test", 1], ["pnpm test", 0]]),
      ".codex/sessions/2026/11/14/rollout-2026-11-14T11-00-00-b.jsonl": rollout("event", [["npm run fmt", 1], ["pnpm run fmt", 0]]),
    });
    const env = { ...process.env, HOME: home, AGENTSOL_WORKSPACE: path.join(home, "ws"), NO_COLOR: "1", COLUMNS: "100" };
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), ...a], { env, encoding: "utf8", cwd: fx.root });
    const human = cli("learn").stdout;
    assert.match(human, /Tokens lost {3}not recorded in these transcripts/);
    const v = JSON.parse(cli("learn", "--propose", "--json").stdout) as { lessons: { times: number; conflicts: { line: number }[] }[]; proposals: { proposalId: string }[] };
    assert.equal(v.lessons[0]?.times, 2, "exit codes come from plain-text output and from exec_command_end");
    assert.deepEqual(v.lessons[0]?.conflicts.map((c) => c.line), [3, 4], "CRLF lines match");
    const diff = cli("review", v.proposals[0]!.proposalId).stdout;
    assert.match(diff, /@@ -1,4 \+1,4 @@\n # Rules\n \n-- Run `npm test` before you commit\.\n\+- Run `pnpm test` before you commit\.\n-- Format with `npm run fmt`\.\n\+- Format with `pnpm run fmt`\.\n/);
    assert.equal((diff.match(/^@@/gm) ?? []).length, 1, "adjacent edits share one hunk");
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("over MCP, lessons go to the file the erring app reads, and every change can be proposed without writing files", async () => {
  const agents = "# Rules\n\n- Keep functions small.\n";
  const claudeMd = "# Claude\n\nBuild with `npm run build`.\n";
  const fx = await fixture({ "AGENTS.md": agents, "CLAUDE.md": claudeMd });
  const home = await tempDir("home");
  let client: Client | undefined;
  try {
    const T = Date.now() - 2 * 86_400_000;
    await writeTree(home, {
      ".claude/projects/-p/a.jsonl": claudeRun(fx.root, T, [["npm test", true], ["pnpm test", false], ["npm run build", true], ["pnpm run build", false]]),
      ".claude/projects/-p/b.jsonl": claudeRun(fx.root, T + 60_000, [["npm test", true], ["pnpm test", false]]),
    });
    const ws = path.join(home, "ws");
    const env = { PATH: process.env.PATH ?? "", HOME: home, AGENTSOL_WORKSPACE: ws, NO_COLOR: "1" };
    assert.equal(spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), "project", "add", fx.root], { env, encoding: "utf8" }).status, 0);
    client = new Client({ name: "learn-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "src/mcp/main.ts"), "--workspace", ws], cwd: REPO, stderr: "pipe", env }));
    const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
      const r = await client!.callTool({ name, arguments: args });
      const c = r.content[0];
      assert.ok(c && c.type === "text");
      return { isError: r.isError === true, text: c.text };
    };
    const projectId = (JSON.parse((await call("projects_list", {})).text) as { projects: { projectId: string }[] }).projects[0]!.projectId;
    assert.equal((await call("sources_scan", { projectId })).isError, false);
    const lr = await call("lessons_list", { projectId, since: "30d" });
    assert.equal(lr.isError, false);
    assert.ok(!lr.text.includes(fx.root) && !lr.text.includes(home), "no absolute paths over MCP");
    type Change = { sourceId: string; baseVersionId: string; edits: { startLine: number; replacementLines: string[] }[]; rationale: string };
    const L = (JSON.parse(lr.text) as { projects: { target: { relPath: string }; suggestedChange: Change; otherChanges: (Change & { relPath: string })[]; notes: string[]; lessons: { conflicts: { file: string; line: number }[] }[] }[] }).projects[0]!;
    assert.equal(L.target.relPath, "CLAUDE.md", "only Claude Code erred and CLAUDE.md does not import AGENTS.md");
    assert.deepEqual(L.lessons[0]?.conflicts.map((c) => [c.file, c.line]), [["CLAUDE.md", 3]]);
    assert.deepEqual(L.suggestedChange.edits.map((e) => e.startLine), [3], "the corrected line is the whole fix");
    assert.deepEqual(L.otherChanges, []);
    assert.ok(L.notes.some((n) => /Rules go to CLAUDE\.md because only Claude Code made these mistakes/.test(n)));
    const pr = await call("change_propose", { projectId, sourceId: L.suggestedChange.sourceId, baseVersionId: L.suggestedChange.baseVersionId, edits: L.suggestedChange.edits, rationale: L.suggestedChange.rationale, requestKey: "learn-test-0001" });
    assert.equal(pr.isError, false, pr.text);
    assert.match(pr.text, /\+Build with `pnpm run build`\./);
    assert.equal(await readFile(path.join(fx.root, "CLAUDE.md"), "utf8"), claudeMd, "proposing never writes the file");
    assert.equal(await readFile(path.join(fx.root, "AGENTS.md"), "utf8"), agents);
  } finally {
    await client?.close();
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});
