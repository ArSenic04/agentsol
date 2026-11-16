import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { commandAdvice, learnLessons, lessonsChange, lessonsEdit, LESSONS_HEADING, LESSONS_INTRO, mainCommand, readsFile, ruleFromCorrection, saidConflicts, codexFileIn } from "../src/core/learn.ts";
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
  for (const c of ["bash -c 'npm test'", `bash -lc "cd app && npm test"`, "pwsh -Command 'npm test'", "cmd /c npm test", "nice -n 10 npm test", "watch -n 1 npm test", "watch -n1 npm test", "timeout -s KILL 60 npm test", "sudo -u ci env CI=1 npm test"]) {
    assert.deepEqual(mainCommand(c), ["npm", "test"], c);
  }
  assert.equal(ruleFromCorrection("no, always run the linter"), "Always run the linter.");
  assert.equal(ruleFromCorrection("from now on use pnpm"), "Use pnpm.");
  assert.equal(ruleFromCorrection("make sure you run the tests before committing"), "Run the tests before committing.");
  assert.equal(ruleFromCorrection("I told you to use uv"), "Use uv.");
  assert.equal(ruleFromCorrection("make sure that the build passes"), "Make sure that the build passes.");
  const add = lessonsEdit(["# Rules", "", "- one", ""], ["Use `pnpm`."]);
  assert.deepEqual(add, { startLine: 3, endLine: 3, expectedText: "- one", replacementLines: ["- one", "", LESSONS_HEADING, "", LESSONS_INTRO, "", "- Use `pnpm`."] });
  assert.match(LESSONS_INTRO, /call project_briefing/);
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

test("learn reads CODEX_HOME, archived Codex sessions, and ignores an empty CLAUDE_CONFIG_DIR", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, {
      "codex-home/sessions/2026/11/01/rollout-2026-11-01T10-00-00-a.jsonl": codexRun(fx.root, T, [["npm test", true], ["pnpm test", false]]),
      "codex-home/archived_sessions/rollout-2026-10-20T10-00-00-b.jsonl": codexRun(fx.root, T - 86_400_000, [["npm test", true], ["pnpm test", false]]),
      ".claude/projects/-p/c.jsonl": claudeRun(fx.root, T + 3_600_000, [["npm test", true], ["pnpm test", false]]),
    });
    const env = { CODEX_HOME: path.join(home, "codex-home"), CLAUDE_CONFIG_DIR: "" };
    const r = await learnLessons({ home, env }, { root: fx.root, since: new Date(0) });
    const npm = r.lessons.find((l) => l.rule?.includes("`pnpm`"));
    assert.ok(npm, JSON.stringify(r.lessons.map((l) => l.rule)));
    assert.equal(npm.sessions, 3);
    assert.deepEqual(npm.clients, ["claude-code", "codex"]);
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("a subagent counts with the session that started it, and another agent's prompt is not the person", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const T = Date.parse("2026-11-01T10:00:00Z");
    const side = (jsonl: string, prompt: string): string => [
      JSON.stringify({ type: "user", isSidechain: true, cwd: fx.root, timestamp: new Date(T).toISOString(), message: { role: "user", content: prompt } }),
      ...jsonl.trim().split("\n").map((l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true })),
    ].join("\n") + "\n";
    const prompt = "Use pnpm instead of npm in this repo and never touch the gen folder";
    await writeTree(home, {
      ".claude/projects/-p/aaaa.jsonl": claudeRun(fx.root, T, [["npm test", true], ["pnpm test", false], ["make release", true], ["make release", true]]),
      ".claude/projects/-p/aaaa/subagents/agent-1.jsonl": side(claudeRun(fx.root, T + 60_000, [["npm test", true], ["pnpm test", false], ["make release", true]]), prompt),
    });
    const one = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0) });
    assert.equal(one.sessionsRead, 1);
    assert.deepEqual(one.lessons.map((l) => [l.kind, l.sessions]), [["command", 1]], "a command that fails in a session and its subagent is not a failure across sessions");

    await writeTree(home, { ".claude/projects/-p/bbbb.jsonl": claudeRun(fx.root, T + 86_400_000, [["npm test", true], ["pnpm test", false]]) + side(claudeRun(fx.root, T + 86_460_000, []), prompt) });
    const two = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0) });
    assert.equal(two.sessionsRead, 2);
    const npm = two.lessons.find((l) => l.rule?.includes("`pnpm`"));
    assert.ok(npm, JSON.stringify(two.lessons.map((l) => l.rule)));
    assert.equal(npm.sessions, 2);
    assert.equal(npm.times, 3);
    assert.ok(!two.lessons.some((l) => l.kind === "correction"), "a prompt written by another agent is never a correction");
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
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
    assert.ok((n.newFileText ?? "").includes(LESSONS_INTRO));
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
    const rollout = (how: "text" | "event" | "stdin", cmds: [string, number][]): string => [
      { timestamp: at(), type: "session_meta", payload: { cwd: fx.root, timestamp: at() } },
      ...cmds.flatMap(([cmd, code], i) => how === "stdin" ? [
        { timestamp: at(), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `c${i}`, arguments: JSON.stringify({ cmd, workdir: fx.root }) } },
        { timestamp: at(), type: "response_item", payload: { type: "function_call_output", call_id: `c${i}`, output: `Wall time: 10.0 seconds\nProcess running with session ID ${40 + i}\nOutput:\n` } },
        { timestamp: at(), type: "response_item", payload: { type: "function_call", name: "write_stdin", call_id: `w${i}`, arguments: JSON.stringify({ session_id: 40 + i, chars: "" }) } },
        { timestamp: at(), type: "response_item", payload: { type: "function_call_output", call_id: `w${i}`, output: `Wall time: 5.0 seconds\nProcess exited with code ${code}\nOutput:\n` } },
      ] : [
        { timestamp: at(), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `c${i}`, arguments: JSON.stringify({ cmd, workdir: fx.root }) } },
        ...(how === "event" ? [{ timestamp: at(), type: "event_msg", payload: { type: "exec_command_end", call_id: `c${i}`, exit_code: code } }] : []),
        { timestamp: at(), type: "response_item", payload: { type: "function_call_output", call_id: `c${i}`, output: how === "text" ? `Wall time: 1.0 seconds\nProcess exited with code ${code}\nOutput:\n` : "done" } },
      ]),
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
    await writeTree(home, {
      ".codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-a.jsonl": rollout("text", [["npm test", 1], ["pnpm test", 0]]),
      ".codex/sessions/2026/11/14/rollout-2026-11-14T11-00-00-b.jsonl": rollout("event", [["npm run fmt", 1], ["pnpm run fmt", 0]]),
      ".codex/sessions/2026/11/14/rollout-2026-11-14T12-00-00-c.jsonl": rollout("stdin", [["npm run build", 1], ["pnpm run build", 0]]),
    });
    const env = { ...process.env, HOME: home, AGENTSOL_WORKSPACE: path.join(home, "ws"), NO_COLOR: "1", COLUMNS: "100" };
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), ...a], { env, encoding: "utf8", cwd: fx.root });
    const human = cli("learn").stdout;
    assert.match(human, /Tokens lost {3}not recorded in these transcripts/);
    const v = JSON.parse(cli("learn", "--propose", "--json").stdout) as { lessons: { times: number; conflicts: { line: number }[] }[]; proposals: { proposalId: string }[] };
    assert.equal(v.lessons[0]?.times, 3, "exit codes come from plain-text output, exec_command_end, and a later write_stdin");
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

test("project_briefing tells an agent starting work what to follow, which lines are out of date and what to ask", async () => {
  const agents = "# Rules\n\n- Run `npm test` before you commit.\n";
  const fx = await fixture({ "AGENTS.md": agents, "src/app.ts": "x\n" });
  const home = await tempDir("home");
  let client: Client | undefined;
  try {
    const T = Date.now() - 2 * 86_400_000;
    await writeTree(home, {
      ".codex/sessions/2026/11/01/rollout-2026-11-01T10-00-00-a.jsonl": codexRun(fx.root, T, [["npm test", true], ["pnpm test", false], ["make release", true], ["make release", true]]),
      ".codex/sessions/2026/11/02/rollout-2026-11-02T10-00-00-b.jsonl": codexRun(fx.root, T + 60_000, [["npm test", true], ["pnpm test", false], ["make release", true]]),
    });
    const ws = path.join(home, "ws");
    const env = { PATH: process.env.PATH ?? "", HOME: home, AGENTSOL_WORKSPACE: ws, NO_COLOR: "1" };
    client = new Client({ name: "briefing-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "src/mcp/main.ts"), "--workspace", ws], cwd: REPO, stderr: "pipe", env }));
    const call = async (args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
      const r = await client!.callTool({ name: "project_briefing", arguments: args });
      const c = r.content[0];
      assert.ok(c && c.type === "text");
      return { isError: r.isError === true, text: c.text };
    };
    const none = await call({ path: path.join(fx.root, "src") });
    assert.equal(none.isError, true);
    assert.match(none.text, /npx -y agentsol@alpha start/, "an unregistered folder says how the person sets it up");

    assert.equal(spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), "project", "add", fx.root], { env, encoding: "utf8" }).status, 0);
    const before = await call({ path: path.join(fx.root, "src") });
    assert.equal(before.isError, false, before.text);
    assert.ok((JSON.parse(before.text) as { notes: string[] }).notes.some((n) => /never scanned/.test(n)));
    const elsewhere = await call({});
    assert.equal(elsewhere.isError, true, "a server started in another specific folder does not brief the only project");
    assert.match(elsewhere.text, /not in a registered project\. Pass path/);
    const atHome = new Client({ name: "briefing-home", version: "0.0.0" });
    try {
      await atHome.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "src/mcp/main.ts"), "--workspace", ws], cwd: home, stderr: "pipe", env }));
      const r = await atHome.callTool({ name: "project_briefing", arguments: {} });
      assert.ok(r.isError !== true, `a server started in the home folder (Claude Desktop, Cursor) uses the only project: ${JSON.stringify(r)}`);
    } finally {
      await atHome.close();
    }

    const projectId = (JSON.parse((await client.callTool({ name: "projects_list", arguments: {} }) as { content: { text: string }[] }).content[0]!.text) as { projects: { projectId: string }[] }).projects[0]!.projectId;
    await client.callTool({ name: "sources_scan", arguments: { projectId } });
    const b = await call({ path: path.join(fx.root, "src") });
    assert.equal(b.isError, false, b.text);
    assert.ok(!b.text.includes(fx.root) && !b.text.includes(home), "no absolute paths");
    const v = JSON.parse(b.text) as { sessionsRead: number; follow: { rule: string; times: number; inInstructions: boolean }[]; outdated: { file: string; line: number; instead: string }[]; askFirst: string[]; text: string };
    assert.equal(v.sessionsRead, 2);
    assert.ok(v.follow.some((f) => f.rule.includes("`pnpm test`") && f.times === 2), JSON.stringify(v.follow));
    assert.deepEqual(v.outdated.map((o) => [o.file, o.line, o.instead]), [["AGENTS.md", 3, "- Run `pnpm test` before you commit."]]);
    assert.ok(v.askFirst.some((x) => x.includes("make release")), JSON.stringify(v.askFirst));
    assert.match(v.text, /^Agentsol briefing for /);
    assert.match(v.text, /AGENTS\.md:3 says: Run `npm test` before you commit\.\n  Do instead: Run `pnpm test` before you commit\./);
    assert.match(v.text, /npx -y agentsol@alpha learn --propose/);
    const check = async (command: string): Promise<{ verdict: string; advice: { instead: string | null }[]; text: string }> => {
      const r = await client!.callTool({ name: "command_check", arguments: { command, path: fx.root } });
      const c = r.content[0];
      assert.ok(c && c.type === "text" && r.isError !== true, JSON.stringify(r));
      return JSON.parse(c.text) as { verdict: string; advice: { instead: string | null }[]; text: string };
    };
    const npmTest = await check("npm test");
    assert.equal(npmTest.verdict, "change");
    assert.deepEqual(npmTest.advice.map((x) => x.instead), ["pnpm test"]);
    assert.match(npmTest.text, /Run instead: pnpm test/);
    assert.equal((await check("make release")).verdict, "ask");
    assert.equal((await check("pnpm test")).verdict, "ok");

    const other = await fixture({ "AGENTS.md": "# Other\n" });
    let here: Client | undefined;
    try {
      assert.equal(spawnSync(process.execPath, [path.join(REPO, "src/cli/main.ts"), "project", "add", other.root], { env, encoding: "utf8" }).status, 0);
      const vague = await call({});
      assert.equal(vague.isError, true, "two projects and a server started elsewhere: the agent must say where it works");
      here = new Client({ name: "briefing-here", version: "0.0.0" });
      await here.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "src/mcp/main.ts"), "--workspace", ws], cwd: path.join(fx.root, "src"), stderr: "pipe", env }));
      const r = await here.callTool({ name: "project_briefing", arguments: {} });
      assert.ok(r.isError !== true, JSON.stringify(r));
      assert.equal((JSON.parse((r.content as { text: string }[])[0]!.text) as { sessionsRead: number }).sessionsRead, 2, "without path, the folder the server started in is used");
    } finally {
      await here?.close();
      await other.cleanup();
    }
    assert.equal(await readFile(path.join(fx.root, "AGENTS.md"), "utf8"), agents, "a briefing never writes files");
  } finally {
    await client?.close();
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("commandAdvice matches a command against lessons before it runs", () => {
  const L = (id: string, kind: "command" | "failing" | "correction", match: Parameters<typeof commandAdvice>[1][number]["match"], rule: string | null = null) => ({ id, kind, rule, title: "", times: 3, sessions: 2, match });
  const lessons = [
    L("L-pm", "command", { kind: "program", bad: "npm", good: "pnpm" }),
    L("L-run", "command", { kind: "runner", bad: "jest", good: "npx jest" }),
    L("L-cmd", "command", { kind: "command", bad: "npm run tst", good: "npm run test" }),
    L("L-never", "failing", { kind: "never", bad: "make release" }),
    L("L-said", "correction", null, "Never run `git push --force`."),
  ];
  const ask = (c: string) => commandAdvice(c, lessons).map((a) => [a.lessonId, a.verdict, a.instead]);
  assert.deepEqual(ask("cd app && npm test -- --watch"), [["L-pm", "change", "cd app && pnpm test -- --watch"]]);
  assert.deepEqual(ask("/usr/local/bin/npm test"), [["L-pm", "change", "pnpm test"]]);
  assert.deepEqual(ask("npm.cmd test"), [["L-pm", "change", "pnpm test"]]);
  assert.deepEqual(ask("bash -lc 'npm ci'"), [["L-pm", "change", "bash -lc 'pnpm ci'"]]);
  assert.deepEqual(ask("pnpm test"), []);
  assert.deepEqual(ask("echo npm && npm test"), [["L-pm", "change", "echo npm && pnpm test"]]);
  assert.deepEqual(ask("sudo -E npm install"), [["L-pm", "change", "sudo -E pnpm install"]]);
  assert.deepEqual(ask("CI=1 npm test"), [["L-pm", "change", "CI=1 pnpm test"]]);
  assert.deepEqual(ask("cmd /c npm test"), [["L-pm", "change", "cmd /c pnpm test"]]);
  assert.deepEqual(ask(`cmd /c "npm test"`), [["L-pm", "change", `cmd /c "pnpm test"`]]);
  assert.deepEqual(ask(`echo "a; npm" && npm test`), [["L-pm", "change", `echo "a; npm" && pnpm test`]]);
  assert.deepEqual(ask("git commit -m 'drop npm; npm is slow' && npm ci"), [["L-pm", "change", "git commit -m 'drop npm; npm is slow' && pnpm ci"]]);
  assert.deepEqual(ask("git add -A && npm test"), [["L-pm", "change", "git add -A && pnpm test"]]);
  assert.deepEqual(ask("cd app && make release VERSION=1"), [["L-never", "ask", null]]);
  assert.deepEqual(ask("npx jest"), []);
  assert.deepEqual(ask("jest --ci"), [["L-run", "change", "npx jest --ci"]]);
  assert.deepEqual(ask("npm run tst").map((x) => x[0]), ["L-pm", "L-cmd"]);
  assert.deepEqual(ask("cd app && npm run tst").find((x) => x[0] === "L-cmd"), ["L-cmd", "change", "cd app && npm run test"]);
  assert.deepEqual(ask("make release VERSION=1"), [["L-never", "ask", null]]);
  assert.deepEqual(ask("make test"), []);
  assert.deepEqual(ask("git push --force origin main"), [["L-said", "ask", null]]);
  assert.deepEqual(ask("git push origin main"), []);
  assert.deepEqual(ask("echo hi"), []);
});

test("learn uses the in-folder steps of sessions started elsewhere, only steps in the window, and drops lessons that stopped being true", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const base = path.dirname(fx.root);
    const other = path.join(base, "other");
    const T = Date.parse("2026-11-01T10:00:00Z");
    const H = 3_600_000;
    const renumber = (s: string, p: string): string => s.replace(/"([tm])(\d+)"/g, `"$1${p}$2"`);
    await writeTree(home, {
      // Started in the parent: only the steps that cd'd into the project count.
      ".claude/projects/-base/parent.jsonl": claudeRun(base, T, [[`cd ${fx.root} && npm install`, true], [`cd ${fx.root} && pnpm install`, false], ["make build", true], ["just build", false]]),
      // A sibling folder that names the project, and one that does not.
      ".claude/projects/-other/sib.jsonl": claudeRun(other, T + H, [[`cd ${fx.root} && npm test`, true], [`cd ${fx.root} && pnpm test`, false]]),
      ".claude/projects/-other/unrelated.jsonl": claudeRun(other, T + 2 * H, [["npm ci", true], ["pnpm ci", false]]),
      // Resumed: the first half is older than the window.
      ".claude/projects/-p/resumed.jsonl": renumber(claudeRun(fx.root, T - 30 * 24 * H, [["yarn test", true], ["bun test", false]]), "o") + claudeRun(fx.root, T + 3 * H, [[`python -c "import x; print(1)"`, true], [`poetry run python -c "import x; print(1)"`, false]]),
      // Failed, was worked around, then ran fine as-is later: no longer a lesson.
      ".claude/projects/-p/old.jsonl": claudeRun(fx.root, T + 4 * H, [["cargo build --release", true], ["cross build --release", false], [`ruby -e '${"x".repeat(60)}'`, true], [`bundle exec ruby -e '${"x".repeat(60)}'`, false]]),
      ".claude/projects/-p/new.jsonl": claudeRun(fx.root, T + 5 * H, [["cargo build --release", false]]),
    });
    const r = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(T - 24 * H) });
    const rules = r.lessons.map((l) => l.rule);
    const npm = r.lessons.find((l) => l.rule?.startsWith("Use `pnpm`"));
    assert.ok(npm, JSON.stringify(rules));
    assert.equal(npm.times, 2, "the parent's cd step and the sibling that names the project, not the unrelated sibling");
    assert.equal(npm.sessions, 2);
    assert.ok(!rules.some((x) => x?.includes("`just`")), "a parent step outside the project is not used");
    assert.ok(!rules.some((x) => x?.includes("`bun`")), "steps older than the window are not used");
    assert.ok(!rules.some((x) => x?.includes("`cross`")), "a command that later ran fine as-is is no longer a lesson");
    assert.ok(rules.includes("Run `python` as `poetry run python` (for example `poetry run python -c 'import x; print(1)'`)."), JSON.stringify(rules));
    assert.ok(rules.includes("Run `ruby` as `bundle exec ruby`."), "a long example is left out");
    assert.equal(r.sessionsRead, 5);
    assert.ok(r.notes.some((n) => n.startsWith("2 sessions started in another folder also worked here.")), JSON.stringify(r.notes));
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("a file is fragile across sessions or after many tries, and the check suggested for it tests that file", async () => {
  const fx = await fixture({});
  const home = await tempDir("home");
  try {
    const f = path.join(fx.root, "src/parser.py");
    type Step = ["edit"] | ["bash", string, boolean];
    const run = (startMs: number, steps: readonly Step[]): string => {
      let t = startMs;
      const at = (): string => new Date((t += 20_000)).toISOString();
      const cwd = fx.root;
      const lines: unknown[] = [{ type: "user", cwd, timestamp: at(), message: { role: "user", content: "go" } }];
      steps.forEach((s, i) => {
        const input = s[0] === "edit" ? { file_path: f, old_string: `a${i}`, new_string: `b${i}` } : { command: s[1] };
        lines.push({ type: "assistant", cwd, timestamp: at(), message: { id: `m${i}`, content: [{ type: "tool_use", id: `t${i}`, name: s[0] === "edit" ? "Edit" : "Bash", input }] } });
        const failed = s[0] === "bash" && s[2];
        lines.push({ type: "user", cwd, timestamp: at(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: failed, content: failed ? "Exit code 1" : "ok" }] } });
      });
      return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    };
    const loop = (tries: number): Step[] => [...Array.from({ length: tries }, (): Step[] => [["edit"], ["bash", "pytest", true]]).flat(), ["edit"],
      ["bash", "ruff format src/parser.py", false], ["bash", "pytest tests/test_other.py", false], ["bash", "pytest tests/test_parser.py", false]];
    const T = Date.parse("2026-11-01T10:00:00Z");
    await writeTree(home, { ".claude/projects/-p/a.jsonl": run(T, loop(2)) });
    const once = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0) });
    assert.ok(!once.lessons.some((l) => l.kind === "fragile"), "two re-fixes in one session can be ordinary work");

    await writeTree(home, { ".claude/projects/-p/b.jsonl": run(T + 3_600_000, loop(3)) });
    const many = await learnLessons({ home, env: {} }, { root: fx.root, since: new Date(0) });
    const frag = many.lessons.find((l) => l.kind === "fragile");
    assert.equal(frag?.rule, "After changing `src/parser.py`, run `pytest tests/test_parser.py` before moving on.", "not the formatter, not a test of another file");
  } finally {
    await fx.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});
