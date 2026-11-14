import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { learnLessons, lessonsEdit, LESSONS_HEADING, mainCommand, ruleFromCorrection } from "../src/core/learn.ts";
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
