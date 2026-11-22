/**
 * Lessons: mistakes agents keep repeating in one project, found across past Claude Code and
 * Codex sessions and turned into rules for the project's instruction file. Deterministic; every
 * lesson cites sessions and steps, and the time it cost is measured from step timestamps.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { containsSecretLike } from "./secrets.ts";
import { canonicalPath, commandSegments, listSessions, programName, shellSegments, showCommand, strip, VERIFY, type LoadedSession, type ProjectLookup, type SessionClient, type SessionContext, type SessionStep } from "./sessions.ts";
import { maskLaunch } from "./setup.ts";

export type LessonKind = "command" | "correction" | "fragile" | "failing";
export type LessonEvidence = { sessionId: string; step: number | null; at: string | null };
/** A line in an instruction file that tells agents to do the thing that fails, and the fixed line. */
export type LessonConflict = { file: string; line: number; text: string; replacement: string };
export type InstructionFile = { relPath: string; lines: readonly string[]; redacted?: readonly number[] };
export type Lesson = {
  id: string;
  kind: LessonKind;
  title: string;
  /** One line for the instruction file, or null when only the person knows the fix. */
  rule: string | null;
  times: number;
  sessions: number;
  lostSteps: number;
  lostMs: number;
  lostTokens: number;
  /** The target instruction file already covers this, yet agents still repeated it. */
  alreadyInFile: boolean;
  /** Instruction files that already state this rule. */
  coveredIn: string[];
  /** Lines in instruction files that tell agents to do what fails here. */
  conflicts: LessonConflict[];
  /** Which apps made the mistake. */
  clients: SessionClient[];
  /** Why a rule that is already written down did not stop the mistake, when that is knowable. */
  why: string | null;
  /** The command this lesson is about, so a command can be checked against it before it runs. */
  match: LessonMatch | null;
  evidence: LessonEvidence[];
};
export type LessonMatch =
  | { kind: "program"; bad: string; good: string }
  | { kind: "runner"; bad: string; good: string }
  | { kind: "command"; bad: string; good: string }
  | { kind: "never"; bad: string };
export type LessonsReport = {
  since: string;
  sessionsRead: number;
  agentMs: number;
  agentTokens: number;
  lostMs: number;
  lostSteps: number;
  lostTokens: number;
  lessons: Lesson[];
  notes: string[];
};

export const LESSON_KINDS: Record<LessonKind, string> = {
  command: "a command that fails here, and the one that works",
  correction: "something you told agents in more than one session",
  fragile: "a file agents keep breaking and re-fixing",
  failing: "a command that keeps failing and was never fixed",
};
export const LESSONS_HEADING = "## Lessons from past agent sessions";
export const LESSONS_INTRO = "Rules learned from mistakes agents repeated in this project. Added after review with `agentsol learn`. If the agentsol tools are connected, call project_briefing with this folder before you start: it has lessons newer than this list.";
export const LESSON_CAVEATS = [
  "Lessons come from patterns in Claude Code and Codex transcripts on this machine. They can miss mistakes and can suggest a rule that was right only once; read each before adding it.",
  "Time lost is the active time from the first failure to the fix, with pauses over 5 minutes counted as 5 minutes. Tokens lost are the session's tokens in proportion to the steps lost.",
  "Corrections are quoted from your own messages, masked and shortened. Nothing else from your messages or tool output is shown.",
];

const MAX_GAP_MS = 5 * 60_000;
const IDLE = new Set(["cd", "export", "source", ".", "echo", "printf", "set", "true", ":", "clear", "sleep", "pwd", "ls", "cat", "which", "type", "tail", "head", "grep", "rg", "sed", "awk", "tee", "less", "wc", "sort", "uniq", "cut", "tr", "jq", "xargs", "column", "date", "wait", "read"]);
const NOT_A_MISTAKE = new Set(["grep", "rg", "test", "[", "diff", "cmp", "which", "ls", "find", "cat", "head", "tail", "pgrep", "pkill", "kill", "lsof", "stat", "file", "command", "type"]);
const RUNNERS = new Set(["npx", "pnpx", "bunx", "pnpm", "yarn", "bun", "uv", "uvx", "poetry", "pipenv", "bundle", "python", "python3", "dotnet", "go", "cargo"]);
const STOP = new Set(["the", "and", "you", "your", "for", "this", "that", "with", "not", "but", "are", "was", "please", "just", "can", "use", "don't", "dont", "never", "always", "again", "stop", "nope", "wrong", "instead", "rather", "than", "said", "told", "should", "need", "have", "has", "it's", "its", "all", "any", "from", "into", "when", "what", "will", "would", "like", "make", "sure"]);

const at = (s: SessionStep): number => (s.at ? Date.parse(s.at) : NaN);
/** Active time between two steps: gaps over five minutes count as five minutes. */
function activeMs(steps: readonly SessionStep[], from: number, to: number): number {
  let ms = 0;
  for (let i = from + 1; i <= to && i < steps.length; i += 1) {
    // A gap over steps kept out (work in another folder) is not time spent here.
    if (steps[i]!.n !== steps[i - 1]!.n + 1) continue;
    const a = at(steps[i - 1]!);
    const b = at(steps[i]!);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) ms += Math.min(b - a, MAX_GAP_MS);
  }
  return ms;
}

const failedAt = (steps: readonly SessionStep[], from: number, to: number): number[] => {
  const out: number[] = [];
  for (let k = from; k < to && k < steps.length; k += 1) if (steps[k]!.kind === "command" && steps[k]!.failed === true) out.push(k);
  return out;
};
/** Time spent on failed steps only: the gap from each failed step to the next one. */
const failedMs = (steps: readonly SessionStep[], from: number, to: number): number => failedAt(steps, from, to).reduce((ms, k) => ms + activeMs(steps, k, k + 1), 0);

/** The command that matters in a command line: skips cd, echo, pipes into tail or grep, and redirections. */
function realCommands(command: string): string[][] {
  const out: string[][] = [];
  // A heredoc body is input (a script, a file's text), not commands: `import os` is not what failed.
  const noBodies = command.replace(/(<<-?\s*(["']?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, "$1");
  for (const seg of commandSegments(noBodies)) {
    const w = strip(seg).filter((x, i, all) => !/^\d*[<>]/.test(x) && !/^\d*[<>]+$/.test(all[i - 1] ?? ""));
    const head = programName(w[0] ?? "");
    if (head && !IDLE.has(head)) out.push([head, ...w.slice(1, 8)]);
  }
  return out;
}
export function mainCommand(command: string): string[] | null {
  return realCommands(command)[0] ?? null;
}

const join = (w: readonly string[]): string => w.join(" ");
/** Words back into a command a shell runs the same way: `python -c 'import x; print(1)'`, not `python -c import x; print(1)`. */
const shJoin = (w: readonly string[]): string => w.map((x) => (/^[\w./:=@%+,~^-]+$/.test(x) ? x : !x.includes("'") ? `'${x}'` : /["$`\\!]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : `"${x}"`)).join(" ");

function matchOf(g: Group): LessonMatch | null {
  // Masked, like the titles: a command can hold a secret.
  if (g.never) return { kind: "never", bad: g.never };
  if (!g.swap) return null;
  if ("program" in g.swap) return { kind: "program", bad: g.swap.program[0], good: g.swap.program[1] };
  if (g.swap.runner) return { kind: "runner", bad: g.swap.command[0], good: g.swap.command[1] };
  return { kind: "command", bad: g.swap.command[0], good: g.swap.command[1] };
}

export type CommandAdvice = { lessonId: string; verdict: "change" | "ask"; reason: string; instead: string | null };
/** What past sessions say about a command before it runs: a version that works here, or that it never worked. */
export function commandAdvice(command: string, lessons: readonly Pick<Lesson, "id" | "kind" | "rule" | "title" | "times" | "sessions" | "match">[]): CommandAdvice[] {
  const all = realCommands(command);
  if (!all.length) return [];
  const heads = new Set(all.map((w) => w[0]));
  const lines = all.map(shJoin);
  // Swap only where the program is the command being run, not an argument such as `echo npm`.
  const isHead = (before: string): boolean => {
    // Separators inside quoted text don't start a command; a quote after `-c` or `/c` does.
    let start = 0;
    let quote = "";
    for (let i = 0; i < before.length; i++) {
      const ch = before.charAt(i);
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === "\\") i++;
      else if (/[;&|(\n]/.test(ch)) start = i + 1;
      else if (ch === "'" || ch === '"') {
        if (/(?:^|\s)-\w*c\s+$|(?:^|\s)\/[ck]\s+$/i.test(before.slice(start, i))) start = i + 1;
        else quote = ch;
      }
    }
    if (quote) return false;
    const seg = before.slice(start).split(/(?:^|\s)\/[ck]\s+/i).pop() ?? "";
    const ws = seg.trim().split(/\s+/).filter(Boolean);
    return strip([...ws, "\0"]).length === 1;
  };
  const swapWord = (bad: string, good: string): string => {
    let done = false;
    return command.replace(new RegExp(`(^|[\\s;&|('"])((?:[^\\s;&|()'"]*[\\\\/])?${esc(bad)}(?:\\.(?:cmd|exe))?)(?=\\s|$|[;&|)'"])`, "gi"), (m, pre: string, _w: string, at: number) => {
      if (done || !isHead(command.slice(0, at + pre.length))) return m;
      done = true;
      return `${pre}${good}`;
    });
  };
  const out: CommandAdvice[] = [];
  const count = (l: { times: number; sessions: number }): string => `${l.times} time${l.times === 1 ? "" : "s"} in ${l.sessions} session${l.sessions === 1 ? "" : "s"}`;
  for (const l of lessons) {
    const m = l.match;
    if (m?.kind === "program" && heads.has(m.bad)) out.push({ lessonId: l.id, verdict: "change", reason: `\`${m.bad}\` failed here ${count(l)}; \`${m.good}\` worked.`, instead: swapWord(m.bad, m.good) });
    else if (m?.kind === "runner" && heads.has(m.bad)) out.push({ lessonId: l.id, verdict: "change", reason: `Running \`${m.bad}\` directly failed here ${count(l)}; \`${m.good}\` worked.`, instead: swapWord(m.bad, m.good) });
    else if (m?.kind === "command" && m.bad && lines.includes(m.bad)) out.push({ lessonId: l.id, verdict: "change", reason: `\`${m.bad}\` failed here ${count(l)}; \`${m.good}\` worked.`, instead: command.includes(m.bad) ? command.replace(m.bad, () => m.good) : all.length === 1 ? m.good : null });
    else if (m?.kind === "never" && lines.some((x) => x === m.bad || x.startsWith(`${m.bad} `))) out.push({ lessonId: l.id, verdict: "ask", reason: `This failed here ${count(l)} and was never fixed. Ask the person how to run it.`, instead: null });
    else if (l.kind === "correction" && l.rule && saidConflicts(l.rule, [{ relPath: "command", lines: [`\`${command.replace(/`/g, "")}\``] }]).length > 0) out.push({ lessonId: l.id, verdict: "ask", reason: `The person told agents more than once: ${l.rule}`, instead: null });
  }
  return out;
}
const pathLike = (w: readonly string[]): boolean => w.slice(1).some((x) => x.includes("/") || /\.\w{1,5}$/.test(x));
const endsWith = (long: readonly string[], short: readonly string[]): boolean =>
  long.length > short.length && long.length - short.length <= 2 && RUNNERS.has(long[0] ?? "") && join(long.slice(long.length - short.length)) === join(short);

/** How a failed command and the next one that worked relate, if the second is a real fix for the first. */
function fixKind(a: readonly string[], b: readonly string[]): "program" | "runner" | "variant" | null {
  if (join(a) === join(b)) return null;
  const rest = (w: readonly string[]): string => join(w.slice(1));
  if (a[0] !== b[0] && rest(a) === rest(b) && (a.length > 1 || (VERIFY.test(join(a)) && VERIFY.test(join(b))))) return "program";
  if (endsWith(a, b) || endsWith(b, a)) return "runner";
  if (a[0] === b[0] && a[1] !== b[1] && a.length <= 4 && b.length <= 4 && VERIFY.test(join(a)) && VERIFY.test(join(b)) && !pathLike(a) && !pathLike(b)) return "variant";
  return null;
}

/** conv groups a subagent with the session that started it; each compaction starts a new one, since the agent forgot what came before. */
type Hit = { sessionId: string; conv: string; client: SessionClient; step: number | null; at: string | null; lostSteps: number; lostMs: number; lostTokens: number };
/** For command lessons: the program swap (npm to pnpm, with the subcommands seen) or the exact command pair. */
type Swap = { program: [bad: string, good: string]; subs: Set<string> } | { command: [bad: string, good: string]; runner?: boolean };
type Group = { kind: LessonKind; title: string; rule: string | null; probe: string[]; hits: Hit[]; swap?: Swap; never?: string };

const words = (t: string): Set<string> => new Set((t.toLowerCase().match(/[a-z0-9_.:@/`'-]{3,}/g) ?? []).map((x) => x.replace(/^[`'.]+|[`'.,:]+$/g, "")).filter((x) => x.length >= 3 && !STOP.has(x)));
const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
};
const tokensFor = (s: LoadedSession, lostSteps: number): number => {
  const total = s.summary.metrics.tokens?.total ?? 0;
  return s.parsed.steps.length > 0 ? Math.round((total * Math.min(lostSteps, s.parsed.steps.length)) / s.parsed.steps.length) : 0;
};

/** Turns a correction the person typed into a rule line. */
export function ruleFromCorrection(text: string): string {
  const lead = /^((no|nope|wrong|stop|ugh|again|hey|ok|okay|actually|wait|hmm|so|and|also)\b[\s,.!:;-]*|(from now on|going forward|in (the )?future|next time)\b[\s,:;-]*|please\s+|(i (said|told you|asked you)|you (should|need to|must|forgot)|remember(?= to\b)|make sure(?! that\b)( you)?)\s+(to\s+)?)+/i;
  let t = text.replace(/\s+/g, " ").trim().replace(lead, "").trim();
  if (t.length > 200) t = `${t.slice(0, 197).replace(/\s+\S*$/, "")}…`;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

type Collected = { session: LoadedSession; root: string };

const inside = (p: string, root: string): boolean => { const r = canonicalPath(p); return r === root || r.startsWith(root + path.sep); };
/** Whether a step from a session started elsewhere worked in `root`: ran there (or `cd`'d there first) or touched a file there. */
function stepIn(t: SessionStep, root: string, home: string): boolean {
  if (t.files.some((f) => inside(f, root)) || t.deleted.some((f) => inside(f, root))) return true;
  if (t.kind !== "command") return false;
  if (inside(t.cwd, root)) return true;
  const cd = /^\s*(?:cd|pushd|Set-Location)\s+(?:-[A-Za-z]+\s+)?(["']?)([^"'&;|\n]+?)\1\s*(?:&&|;|\n|$)/.exec(t.command ?? "");
  const dir = cd?.[2]?.trim();
  if (!dir) return false;
  const target = dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : path.resolve(t.cwd, dir);
  return inside(target, root);
}

function analyze(all: readonly Collected[], home: string): Group[] {
  const groups = new Map<string, Group>();
  const group = (key: string, g: Omit<Group, "hits">): Group => {
    let x = groups.get(key);
    if (!x) { x = { ...g, hits: [] }; groups.set(key, x); }
    return x;
  };
  const corrections: { sessionId: string; conv: string; client: SessionClient; step: number | null; at: string | null; text: string; words: Set<string> }[] = [];
  const failing = new Map<string, { shown: string; hits: Hit[] }>();
  const fragile = new Map<string, { verify: Map<string, number>; hits: Hit[]; most: number }>();
  const worked = new Set<string>();
  const lastWorked = new Map<string, number>();
  for (const { session } of all) for (const t of session.parsed.steps) {
    if (t.kind !== "command" || t.failed !== false) continue;
    const k = join(mainCommand(t.command ?? "") ?? []);
    worked.add(k);
    const at = t.at ? Date.parse(t.at) : NaN;
    if (at > (lastWorked.get(k) ?? -Infinity)) lastWorked.set(k, at);
  }
  const failedAs = new Map<Group, Set<string>>();

  for (const { session, root } of all) {
    const steps = session.parsed.steps;
    const id = session.summary.id;
    const client = session.summary.client;
    // After a compaction the agent has forgotten earlier turns, so a repeat there counts like a new session.
    const base = session.summary.parentId ?? id;
    const convOf = (k: number): string => (k > 0 && !session.summary.parentId ? `${base}#${k}` : base);
    const convAt = (n: number | null | undefined): string => convOf(n == null ? 0 : session.parsed.resets.filter((r) => r <= n).length);
    const show = (w: readonly string[]): string => showCommand(shJoin(w), session.actx);
    // A long example buries the rule; the rule alone is enough.
    const eg = (w: readonly string[]): string => { const x = show(w); return x.length <= 60 ? ` (for example \`${x}\`)` : ""; };
    const fixed = new Set<number>();
    const resolved = new Set<number>();

    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i]!;
      if (s.kind !== "command" || s.failed !== true) continue;
      const a = mainCommand(s.command ?? "");
      if (!a || NOT_A_MISTAKE.has(a[0] ?? "")) continue;
      for (let j = i + 1; j < Math.min(steps.length, i + 14); j += 1) {
        const t = steps[j]!;
        if (t.kind === "edit" || t.kind === "write" || t.kind === "delete") break;
        if (t.kind !== "command") continue;
        const b = mainCommand(t.command ?? "");
        if (!b) continue;
        if (join(b) === join(a)) { if (t.failed === false) { resolved.add(i); break; } continue; }
        if (t.failed !== false) continue;
        const kind = fixKind(a, b);
        if (kind && !fixed.has(j)) {
          fixed.add(j);
          resolved.add(i);
          const lostSteps = failedAt(steps, i, j).length;
          const hit: Hit = { sessionId: id, conv: convAt(s.n), client, step: s.n, at: s.at, lostSteps, lostMs: failedMs(steps, i, j), lostTokens: tokensFor(session, lostSteps) };
          const [a0, b0] = [a[0] ?? "", b[0] ?? ""];
          let g: Group;
          if (kind === "program" && a.length > 1) {
            g = group(`program:${a0}>${b0}`, { kind: "command", title: `Agents use \`${a0}\` here, which fails; \`${b0}\` works${eg(b)}.`, rule: `Use \`${b0}\`, not \`${a0}\`${eg(b)}.`, probe: [b0], swap: { program: [a0, b0], subs: new Set() } });
            if (g.swap && "program" in g.swap && a[1]) g.swap.subs.add(a[1]);
          } else if (kind === "runner" && b.length > a.length) {
            const runner = show(b.slice(0, b.length - a.length));
            g = group(`runner:${a0}>${runner}`, { kind: "command", title: `Agents run \`${a0}\` directly, which fails here; \`${runner} ${a0}\` works${eg(b)}.`, rule: `Run \`${a0}\` as \`${runner} ${a0}\`${eg(b)}.`, probe: [`${runner} ${a0}`], swap: { command: [a0, `${runner} ${a0}`], runner: true } });
          } else {
            g = group(`cmd:${join(a)}>${join(b)}`, { kind: "command", title: `Agents run \`${show(a)}\`, which fails here; \`${show(b)}\` works.`, rule: `Run \`${show(b)}\`, not \`${show(a)}\`.`, probe: [show(b)], swap: { command: [show(a), show(b)] } });
          }
          g.hits.push(hit);
          failedAs.set(g, (failedAs.get(g) ?? new Set()).add(join(a)));
        } else if (fixed.has(j)) resolved.add(i);
        break;
      }
      if (!resolved.has(i) && !worked.has(join(a))) {
        const k = join(a);
        const f = failing.get(k) ?? { shown: show(a), hits: [] };
        f.hits.push({ sessionId: id, conv: convAt(s.n), client, step: s.n, at: s.at, lostSteps: 1, lostMs: activeMs(steps, i, i + 1), lostTokens: tokensFor(session, 1) });
        failing.set(k, f);
      }
    }

    // Fix loops: a file edited, a command fails, the same file edited again, before anything passes.
    const loops = new Map<string, { n: number; first: number; last: number }>();
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i]!;
      if (s.kind !== "edit" && s.kind !== "write") continue;
      for (const file of s.files) {
        let failedSeen = false;
        for (let j = i + 1; j < steps.length; j += 1) {
          const t = steps[j]!;
          if (t.kind === "command" && t.failed === true) failedSeen = true;
          else if (t.kind === "command" && t.failed === false && VERIFY.test(t.command ?? "")) break;
          if ((t.kind === "edit" || t.kind === "write") && t.files.includes(file)) {
            if (failedSeen) {
              const l = loops.get(file) ?? { n: 0, first: i, last: j };
              l.n += 1;
              l.last = j;
              loops.set(file, l);
            }
            break;
          }
        }
      }
    }
    for (const [file, l] of loops) {
      const real = canonicalPath(file);
      if (l.n < 2 || !(real === root || real.startsWith(root + path.sep))) continue;
      const rel = path.relative(root, real).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      const passes = steps.slice(l.last + 1).filter((t) => t.kind === "command" && t.failed === false && VERIFY.test(t.command ?? ""));
      const pass = passes[0];
      const end = pass ? steps.indexOf(pass) : l.last;
      const f = fragile.get(rel) ?? { verify: new Map<string, number>(), hits: [], most: 0 };
      f.most = Math.max(f.most, l.n);
      // The check to suggest: one that tests this file (or everything), not a formatter or a check of some other file.
      const stem = path.basename(rel).replace(/\.[^.]+$/, "");
      const fits = (w: readonly string[]): boolean => !w.some((x) => /^(format|fmt|--fix|--write|-w)$/.test(x) || /^(prettier|black|gofmt|rustfmt|isort)$/.test(x))
        && (!pathLike(w) || w.slice(1).some((x) => { const a = x.replace(/^\.\//, "").replace(/\/$/, ""); return a === rel || rel.startsWith(`${a}/`) || path.basename(a).includes(stem); }));
      const v = passes.map((t) => mainCommand(t.command ?? "")).find((w): w is string[] => w !== null && fits(w)) ?? null;
      if (v) { const shown = show(v); f.verify.set(shown, (f.verify.get(shown) ?? 0) + 1); }
      const lostSteps = failedAt(steps, l.first, end).length;
      f.hits.push({ sessionId: id, conv: convAt(steps[l.first]?.n), client, step: steps[l.first]?.n ?? null, at: steps[l.first]?.at ?? null, lostSteps, lostMs: failedMs(steps, l.first, end), lostTokens: tokensFor(session, lostSteps) });
      fragile.set(rel, f);
    }

    for (const said of session.parsed.said) {
      const text = maskLaunch(said.text, home, 240);
      if (containsSecretLike(said.text)) continue;
      corrections.push({ sessionId: id, conv: convOf(said.resets), client, step: said.afterStep > 0 ? said.afterStep : null, at: said.at, text, words: words(text) });
    }
  }

  for (const [k, f] of failing) {
    if (new Set(f.hits.map((h) => h.conv)).size < 2 || f.hits.length < 3) continue;
    group(`failing:${k}`, { kind: "failing", title: `\`${f.shown}\` failed ${f.hits.length} times in ${new Set(f.hits.map((h) => h.conv)).size} sessions and was never fixed. Write down how to run it here.`, rule: null, probe: [], never: f.shown }).hits.push(...f.hits);
  }
  for (const [rel, f] of fragile) {
    // Two re-fixes in one session can be ordinary work; call a file fragile across sessions or after many tries.
    if (new Set(f.hits.map((h) => h.conv)).size < 2 && f.most < 3) continue;
    const v = [...f.verify.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    group(`fragile:${rel}`, {
      kind: "fragile",
      title: `Agents broke and re-fixed \`${rel}\` in ${new Set(f.hits.map((h) => h.conv)).size} session${f.hits.length === 1 ? "" : "s"}.`,
      rule: v ? `After changing \`${rel}\`, run \`${v}\` before moving on.` : `\`${rel}\` usually takes several tries: read its tests and callers before changing it.`,
      probe: [rel],
    }).hits.push(...f.hits);
  }

  const used = new Set<number>();
  corrections.forEach((c, i) => {
    if (used.has(i)) return;
    const cluster = [c];
    used.add(i);
    corrections.forEach((d, j) => {
      if (used.has(j) || d.conv === c.conv) return;
      if (jaccard(c.words, d.words) >= 0.4) { cluster.push(d); used.add(j); }
    });
    const sessions = new Set(cluster.map((x) => x.conv));
    if (sessions.size < 2) return;
    const best = [...cluster].sort((x, y) => x.text.length - y.text.length)[0]!;
    const said = new Set(cluster.flatMap((x) => [...x.words]));
    const same = [...groups.entries()].find(([k]) => { const m = /^program:(.+)>(.+)$/.exec(k); return m && said.has(m[1]!) && said.has(m[2]!); })?.[1];
    if (same) {
      same.title += ` You also told agents this yourself in ${sessions.size} sessions.`;
      return;
    }
    group(`said:${i}`, { kind: "correction", title: `You told agents this in ${sessions.size} sessions: “${best.text}”`, rule: ruleFromCorrection(best.text), probe: [...best.words] }).hits.push(...cluster.map((x) => ({ sessionId: x.sessionId, conv: x.conv, client: x.client, step: x.step, at: x.at, lostSteps: 1, lostMs: 0, lostTokens: 0 })));
  });

  // A command that failed and later ran fine as-is means the project changed; the lesson is out of date.
  const outdated = (g: Group): boolean => {
    const last = Math.max(...g.hits.map((h) => (h.at ? Date.parse(h.at) : NaN)).filter((x) => !Number.isNaN(x)));
    return last > -Infinity && [...(failedAs.get(g) ?? [])].some((k) => (lastWorked.get(k) ?? -Infinity) > last);
  };
  return [...groups.values()].filter((g) => !outdated(g));
}

/** True when the instruction file already covers the lesson. */
function covered(g: Group, fileText: string): boolean {
  if (!fileText) return false;
  const lower = fileText.toLowerCase();
  if (g.kind === "correction") {
    const want = new Set(g.probe);
    return fileText.split(/\r?\n/).some((l) => jaccard(want, words(l)) >= 0.5);
  }
  return g.probe.length > 0 && g.probe.every((p) => lower.includes(p.toLowerCase().replace(/^`|`$/g, "")));
}

const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Lines that already warn against the command are advice, not a conflict. */
const NEGATED = /\b(never|don'?t|do not|not|avoid|instead|rather than|no longer|deprecated|fails?|broken)\b/i;
export const COMMON_SUBS = ["run", "test", "install", "i", "ci", "add", "exec", "x", "start", "build", "lint", "dev"];
const BEFORE = "(^|[\\s`'\"(>])";

const NEGATION = /\b(never|don'?t|do not|stop|avoid|no longer)\s+/i;
const INSTEAD = /\b(?:instead of|rather than)\s+|,\s*not\s+/i;
/** "in unit tests" → "unit": a rule about integration tests does not contradict one about unit tests. */
const scopeOf = (text: string): string | null => {
  const m = /\b(?:in|for|during)\s+(?:the\s+|a\s+|an\s+)?([a-z0-9_.-]+)/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
};
/**
 * Lines that tell agents to do what a repeated correction forbids ("never edit gen/" against
 * "Edit gen/ when the API changes"), each replaced by the correction's rule.
 */
export function saidConflicts(rule: string, files: readonly InstructionFile[]): LessonConflict[] {
  const m = NEGATION.exec(rule) ?? INSTEAD.exec(rule);
  if (!m) return [];
  const body = rule.slice(m.index + m[0].length);
  const lead = /^(?:use|run)\s+/i.exec(body)?.[0] ?? "";
  const clause = lead + (body.slice(lead.length).split(/[,;.!]|\b(?:use|run|instead|rather|but|and then|in this)\b/i)[0] ?? "");
  const banned = words(clause);
  if (banned.size === 0) return [];
  // One banned word ("never use yarn") only counts where the line tells agents to use it, not in prose.
  const only = banned.size === 1 ? esc([...banned][0]!) : null;
  const ruleScope = scopeOf(clause);
  const asOrder = only ?new RegExp(`\`${only}|^\\s*(?:[-*+]|\\d+[.)])?\\s*${only}\\b|\\b(?:use|run|with|via|using)\\s+${only}\\b`, "i") : null;
  const out: LessonConflict[] = [];
  for (const f of files) {
    const masked = new Set(f.redacted ?? []);
    let fenced = false;
    f.lines.forEach((text, i) => {
      if (/^\s*(```|~~~)/.test(text)) { fenced = !fenced; return; }
      if (fenced || masked.has(i + 1) || /^\s*(#|>|<!--)/.test(text) || NEGATED.test(text)) return;
      const have = words(text);
      let shared = 0;
      for (const w of banned) if (have.has(w)) shared += 1;
      if (shared < Math.min(2, banned.size) || shared / banned.size < 0.6 || (asOrder && !asOrder.test(text))) return;
      const lineScope = scopeOf(text);
      if (ruleScope && lineScope && ruleScope !== lineScope) return;
      const prefix = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(text)?.[0] ?? "";
      out.push({ file: f.relPath, line: i + 1, text, replacement: `${prefix}${rule}` });
    });
  }
  return out;
}

/** Lines in instruction files that tell agents to run what fails here, each with the corrected line. */
export function conflictsFor(swap: Swap | undefined, files: readonly InstructionFile[]): LessonConflict[] {
  if (!swap) return [];
  let find: RegExp;
  let good: RegExp;
  let fix: (line: string) => string;
  if ("program" in swap) {
    const [bad, ok] = swap.program;
    const subs = [...new Set([...swap.subs, ...COMMON_SUBS])].map(esc).join("|");
    find = new RegExp(`${BEFORE}${esc(bad)}(?=\\s+(?:${subs})(?![\\w-]))`, "g");
    good = new RegExp(`${BEFORE}${esc(ok)}(?![\\w-])`);
    fix = (line) => line.replace(find, (_m, pre: string) => `${pre}${ok}`);
  } else {
    const [bad, ok] = swap.command;
    // `uv run pytest` or `python -m pytest` already goes through a runner.
    const via = swap.runner ? `(?<!(?:${[...RUNNERS].map(esc).join("|")})\\s+(?:run\\s+|exec\\s+|-m\\s+)?)` : "";
    find = new RegExp(`${BEFORE}${via}${esc(bad)}(?![\\w:@/-]|\\.\\w)`, "g");
    good = new RegExp(esc(ok));
    fix = (line) => line.replace(find, (_m, pre: string) => `${pre}${ok}`);
  }
  // A bare word like `pytest` is only a command in code or right after "run"; in prose it is a topic.
  const asCode = (text: string, fenced: boolean): boolean => {
    if (fenced || "program" in swap) return true;
    find.lastIndex = 0;
    for (let m = find.exec(text); m; m = find.exec(text)) {
      const before = text.slice(0, m.index + (m[1]?.length ?? 0));
      if ((before.split("`").length - 1) % 2 === 1 || /\b(run|runs|running|execute|with)\s+$/i.test(before) || /^\s*([-*]\s+)?\$?\s*$/.test(before)) return true;
    }
    return false;
  };
  const out: LessonConflict[] = [];
  for (const f of files) {
    const masked = new Set(f.redacted ?? []);
    let fenced = false;
    f.lines.forEach((text, i) => {
      if (/^\s*(```|~~~)/.test(text)) { fenced = !fenced; return; }
      find.lastIndex = 0;
      if (masked.has(i + 1) || !find.test(text) || good.test(text) || NEGATED.test(text) || !asCode(text, fenced)) return;
      find.lastIndex = 0;
      const replacement = fix(text);
      if (replacement !== text) out.push({ file: f.relPath, line: i + 1, text, replacement });
    });
  }
  return out;
}

const CLIENT_NAME: Record<SessionClient, string> = { "claude-code": "Claude Code", codex: "Codex" };
const base = (rel: string): string => rel.split("/").pop() ?? rel;
const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "");
/** The file Codex loads from a folder: a non-empty AGENTS.override.md replaces AGENTS.md there. */
export function codexFileIn(dir: string, files: readonly InstructionFile[]): string {
  const over = files.find((f) => f.relPath === `${dir}AGENTS.override.md` && f.lines.some((l) => l.trim() !== ""));
  return over ? over.relPath : `${dir}AGENTS.md`;
}
/** Whether an app loads this instruction file on its own. Claude Code reads AGENTS.md only through an @AGENTS.md import. */
export function readsFile(client: SessionClient, rel: string, files: readonly InstructionFile[]): boolean {
  const b = base(rel);
  const dir = dirOf(rel);
  if (client === "codex") return (b === "AGENTS.md" || b === "AGENTS.override.md") && codexFileIn(dir, files) === rel;
  if (b === "CLAUDE.md" || b === "CLAUDE.local.md") return true;
  if (b !== "AGENTS.md" && b !== "AGENTS.override.md") return false;
  const name = new RegExp(`^\\s*@(\\./)?${esc(b)}(?![\\w.])`);
  return files.some((f) => base(f.relPath) === "CLAUDE.md" && (f.relPath.startsWith(dir) || f.relPath === ".claude/CLAUDE.md") && f.lines.some((l) => name.test(l)));
}

function whyRepeated(clients: readonly SessionClient[], coveredIn: readonly string[], files: readonly InstructionFile[]): string | null {
  if (coveredIn.length === 0) return null;
  const blind = clients.filter((c) => !coveredIn.some((f) => readsFile(c, f, files)));
  const where = coveredIn.join(" and ");
  if (blind.length === 0) return `Agents had this rule in ${where} and repeated the mistake anyway. Make it more specific (the exact command or file), or move it near the top.`;
  const names = blind.map((c) => CLIENT_NAME[c]).join(" and ");
  const codex = codexFileIn("", files);
  const reads = codex === "AGENTS.md" ? "Codex reads AGENTS.md" : `Here Codex reads ${codex}, which replaces AGENTS.md`;
  if (blind.includes("codex")) return `The rule is in ${where}, but ${names} made this mistake and ${blind.length === 1 ? "does" : "do"} not read ${coveredIn.length === 1 ? "it" : "them"}. ${reads}; put the rule there${blind.includes("claude-code") ? ` and add @${codex} to CLAUDE.md` : ""}.`;
  return `The rule is in ${where}, but Claude Code made this mistake and does not read ${coveredIn.length === 1 ? "it" : "them"}. Add a line with @${base(coveredIn.find((f) => base(f).startsWith("AGENTS")) ?? "AGENTS.md")} to CLAUDE.md, or put the rule in CLAUDE.md.`;
}

export type LearnOptions = {
  root: string; since: Date; project?: ProjectLookup; requireProject?: boolean; limit?: number;
  /** Text of the target instruction file (kept for callers that only have one file). */
  instructionText?: string;
  /** Every instruction file in the project, for conflicts and for where rules already live. */
  files?: readonly InstructionFile[];
  /** relPath of the file new rules go into. */
  target?: string;
};

/** Reads past sessions that ran inside `root` and returns the lessons, most costly first. */
export async function learnLessons(ctx: SessionContext, opts: LearnOptions): Promise<LessonsReport> {
  const collected: Collected[] = [];
  const root = canonicalPath(opts.root);
  const fromElsewhere = new Set<string>();
  const since = opts.since.getTime();
  const fresh = (at: string | null): boolean => at === null || !(Date.parse(at) < since);
  /** The part of a session in the window (a resumed session keeps older steps) and, for one started elsewhere, in this folder, with its share of the tokens. */
  const trim = (session: LoadedSession, here: (s: SessionStep) => boolean, keepSaid: boolean): LoadedSession | null => {
    const all = session.parsed.steps;
    const steps = all.filter((t) => fresh(t.at) && here(t));
    const said = keepSaid ? session.parsed.said.filter((x) => fresh(x.at)) : [];
    if (steps.length === all.length && said.length === session.parsed.said.length) return session;
    if (steps.length === 0 && said.length === 0) return null;
    const tokens = session.summary.metrics.tokens;
    const share = all.length > 0 ? steps.length / all.length : 1;
    const summary = { ...session.summary, metrics: { ...session.summary.metrics, tokens: tokens ? { ...tokens, total: Math.round(tokens.total * share) } : tokens } };
    return { ...session, summary, parsed: { ...session.parsed, steps, said } };
  };
  const list = await listSessions(ctx, {
    since: opts.since, limit: opts.limit ?? 300, cwdWithin: opts.root, requireProject: opts.requireProject ?? false,
    ...(opts.project ? { project: opts.project } : {}),
    onLoaded: (session) => { const t = trim(session, () => true, true); if (t) collected.push({ session: t, root }); },
    onParent: (session) => {
      // What the person said in a session that also worked elsewhere can't be tied to this folder.
      const t = trim(session, (s) => stepIn(s, root, ctx.home), false);
      if (!t) return;
      collected.push({ session: t, root });
      fromElsewhere.add(session.summary.parentId ?? session.summary.id);
    },
  });
  const compactions = collected.reduce((n, c) => n + (c.session.summary.parentId ? 0 : c.session.parsed.resets.length), 0);
  if (compactions > 0) list.notes.push(`Long conversations were compacted ${compactions} time${compactions === 1 ? "" : "s"}. The agent forgets earlier turns at each compaction, so a mistake repeated after one counts as a repeat in a new session.`);
  if (fromElsewhere.size > 0) list.notes.push(`${fromElsewhere.size} session${fromElsewhere.size === 1 ? "" : "s"} started in another folder also worked here. Only their steps in this folder were used, not what you said in them.`);
  const files: readonly InstructionFile[] = opts.files ?? (opts.instructionText ? [{ relPath: opts.target ?? "AGENTS.md", lines: opts.instructionText.split(/\r?\n/) }] : []);
  const target = opts.target ?? files[0]?.relPath ?? null;
  const lessons: Lesson[] = analyze(collected, ctx.home)
    .filter((g) => g.kind !== "command" || g.hits.length >= 2 || (g.swap !== undefined && ("program" in g.swap || g.swap.runner === true)))
    .map((g): Lesson => {
      const sessions = new Set(g.hits.map((h) => h.conv));
      const sum = (k: "lostSteps" | "lostMs" | "lostTokens"): number => g.hits.reduce((a, h) => a + h[k], 0);
      const key = `${g.kind}:${g.rule ?? g.title}`;
      const conflicts = g.kind === "correction" && g.rule ? saidConflicts(g.rule, files) : conflictsFor(g.swap, files);
      const coveredIn = files.filter((f) => !conflicts.some((c) => c.file === f.relPath) && covered(g, f.lines.join("\n"))).map((f) => f.relPath);
      const clients = [...new Set(g.hits.map((h) => h.client))].sort();
      const first = conflicts[0];
      const title = first
        ? `Your instructions tell agents to do this (${conflicts.slice(0, 4).map((c) => `${c.file}:${c.line}`).join(", ")}${conflicts.length > 4 ? ", …" : ""}). ${g.title}`
        : g.title;
      return {
        id: `L-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`,
        kind: g.kind, title, rule: g.rule, times: g.hits.length, sessions: sessions.size,
        lostSteps: sum("lostSteps"), lostMs: sum("lostMs"), lostTokens: sum("lostTokens"),
        alreadyInFile: target !== null && coveredIn.includes(target),
        coveredIn, conflicts, clients,
        why: conflicts.length > 0 ? null : whyRepeated(clients, coveredIn, files),
        match: matchOf(g),
        evidence: g.hits.slice(0, 6).map((h) => ({ sessionId: h.sessionId, step: h.step, at: h.at })),
      };
    })
    .sort((a, b) => b.lostMs - a.lostMs || b.times - a.times || a.id.localeCompare(b.id))
    .slice(0, 25);
  const agentMs = collected.reduce((a, c) => a + activeMs(c.session.parsed.steps, 0, c.session.parsed.steps.length - 1), 0);
  const agentTokens = collected.reduce((a, c) => a + (c.session.summary.metrics.tokens?.total ?? 0), 0);
  return {
    since: opts.since.toISOString(),
    sessionsRead: new Set(collected.map((c) => c.session.summary.parentId ?? c.session.summary.id)).size,
    agentMs, agentTokens,
    lostMs: lessons.reduce((a, l) => a + l.lostMs, 0),
    lostSteps: lessons.reduce((a, l) => a + l.lostSteps, 0),
    lostTokens: lessons.reduce((a, l) => a + l.lostTokens, 0),
    lessons,
    notes: list.notes.map((x) => x.replace(/ They may still have changed files here; list them with: .*$| It may still have changed files here; list it with: .*$/, " Lessons only use sessions started in this folder or below; start your agent here to include them.")),
  };
}

/** One line edit that adds rules under the lessons heading, creating the heading at the end if needed. */
export function lessonsEdit(lines: readonly string[], rules: readonly string[]): { startLine: number; endLine: number; expectedText: string; replacementLines: string[] } | null {
  if (lines.length === 0 || rules.length === 0) return null;
  const bullets = rules.map((r) => `- ${r}`);
  const h = lines.findIndex((l) => l.trim() === LESSONS_HEADING);
  if (h >= 0) {
    let end = h;
    for (let i = h + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i] ?? ""); i += 1) if ((lines[i] ?? "").trim() !== "") end = i;
    return { startLine: end + 1, endLine: end + 1, expectedText: lines[end] ?? "", replacementLines: [lines[end] ?? "", ...bullets] };
  }
  let last = lines.length - 1;
  while (last > 0 && (lines[last] ?? "").trim() === "") last -= 1;
  return { startLine: last + 1, endLine: last + 1, expectedText: lines[last] ?? "", replacementLines: [lines[last] ?? "", "", LESSONS_HEADING, "", LESSONS_INTRO, "", ...bullets] };
}

export type LessonEdit = { startLine: number; endLine: number; expectedText: string; replacementLines: string[] };

/**
 * Every edit for one file: conflicting lines are corrected in place, and rules not already
 * written there (or fixed by a correction) are added under the lessons heading.
 */
export function lessonsChange(file: InstructionFile, lessons: readonly Lesson[]): { edits: LessonEdit[]; fixed: number; added: string[] } {
  const masked = new Set(file.redacted ?? []);
  const lines = [...file.lines];
  const fixedLines = new Map<number, string>();
  const solved = new Set<string>();
  for (const l of lessons) for (const c of l.conflicts) {
    if (c.file !== file.relPath || masked.has(c.line)) continue;
    if (fixedLines.has(c.line) || lines[c.line - 1] !== c.text) continue;
    fixedLines.set(c.line, c.replacement);
    solved.add(l.id);
  }
  // A lesson whose cause is a wrong line anywhere is fixed by correcting that line, not by a second rule.
  const added = [...new Set(lessons.filter((l) => l.rule && !solved.has(l.id) && l.conflicts.length === 0 && !l.coveredIn.includes(file.relPath)).map((l) => l.rule as string))].slice(0, 12);
  const edits: LessonEdit[] = [];
  const append = lessonsEdit(lines, added);
  if (append && masked.has(append.startLine)) return { edits: [...fixedLines].map(([n, t]) => ({ startLine: n, endLine: n, expectedText: lines[n - 1] ?? "", replacementLines: [t] })), fixed: fixedLines.size, added: [] };
  for (const [n, t] of fixedLines) if (!append || n !== append.startLine) edits.push({ startLine: n, endLine: n, expectedText: lines[n - 1] ?? "", replacementLines: [t] });
  if (append) {
    const own = fixedLines.get(append.startLine);
    edits.push(own === undefined ? append : { ...append, replacementLines: [own, ...append.replacementLines.slice(1)] });
  }
  return { edits: edits.sort((a, b) => a.startLine - b.startLine), fixed: fixedLines.size, added };
}
