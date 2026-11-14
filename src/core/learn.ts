/**
 * Lessons: mistakes agents keep repeating in one project, found across past Claude Code and
 * Codex sessions and turned into rules for the project's instruction file. Deterministic; every
 * lesson cites sessions and steps, and the time it cost is measured from step timestamps.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { containsSecretLike } from "./secrets.ts";
import { listSessions, shellSegments, showCommand, strip, VERIFY, type LoadedSession, type ProjectLookup, type SessionContext, type SessionStep } from "./sessions.ts";
import { maskLaunch } from "./setup.ts";

export type LessonKind = "command" | "correction" | "fragile" | "failing";
export type LessonEvidence = { sessionId: string; step: number | null; at: string | null };
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
  /** The instruction file already covers this, yet agents still repeated it. */
  alreadyInFile: boolean;
  evidence: LessonEvidence[];
};
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
    const a = at(steps[i - 1]!);
    const b = at(steps[i]!);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) ms += Math.min(b - a, MAX_GAP_MS);
  }
  return ms;
}

/** The command that matters in a command line: skips cd, echo, pipes into tail or grep, and redirections. */
export function mainCommand(command: string): string[] | null {
  for (const seg of shellSegments(command)) {
    const w = strip(seg).filter((x, i, all) => !/^\d*[<>]/.test(x) && !/^\d*[<>]+$/.test(all[i - 1] ?? ""));
    const head = path.basename(w[0] ?? "");
    if (!head || IDLE.has(head)) continue;
    return [head, ...w.slice(1, 8)];
  }
  return null;
}

const join = (w: readonly string[]): string => w.join(" ");
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

type Hit = { sessionId: string; step: number | null; at: string | null; lostSteps: number; lostMs: number; lostTokens: number };
type Group = { kind: LessonKind; title: string; rule: string | null; probe: string[]; hits: Hit[] };

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
  let t = text.replace(/\s+/g, " ").trim().replace(/^((no|nope|wrong|stop|ugh|again|hey|ok|okay)\b[\s,.!:;-]*)+/i, "").trim();
  t = t.replace(/^please\s+/i, "");
  if (t.length > 200) t = `${t.slice(0, 197).replace(/\s+\S*$/, "")}…`;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

type Collected = { session: LoadedSession; root: string };

function analyze(all: readonly Collected[], home: string): Group[] {
  const groups = new Map<string, Group>();
  const group = (key: string, g: Omit<Group, "hits">): Group => {
    let x = groups.get(key);
    if (!x) { x = { ...g, hits: [] }; groups.set(key, x); }
    return x;
  };
  const corrections: { sessionId: string; step: number | null; at: string | null; text: string; words: Set<string> }[] = [];
  const failing = new Map<string, { shown: string; hits: Hit[] }>();
  const fragile = new Map<string, { verify: Map<string, number>; hits: Hit[] }>();
  const worked = new Set<string>();
  for (const { session } of all) for (const t of session.parsed.steps) if (t.kind === "command" && t.failed === false) worked.add(join(mainCommand(t.command ?? "") ?? []));

  for (const { session, root } of all) {
    const steps = session.parsed.steps;
    const id = session.summary.id;
    const show = (w: readonly string[]): string => showCommand(join(w), session.actx);
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
          const lostSteps = j - i;
          const hit: Hit = { sessionId: id, step: s.n, at: s.at, lostSteps, lostMs: activeMs(steps, i, j), lostTokens: tokensFor(session, lostSteps) };
          const [a0, b0] = [a[0] ?? "", b[0] ?? ""];
          if (kind === "program" && a.length > 1) {
            group(`program:${a0}>${b0}`, { kind: "command", title: `Agents use \`${a0}\` here, which fails; \`${b0}\` works (for example \`${show(b)}\`).`, rule: `Use \`${b0}\`, not \`${a0}\` (for example \`${show(b)}\`).`, probe: [b0] }).hits.push(hit);
          } else {
            group(`cmd:${join(a)}>${join(b)}`, { kind: "command", title: `Agents run \`${show(a)}\`, which fails here; \`${show(b)}\` works.`, rule: `Run \`${show(b)}\`, not \`${show(a)}\`.`, probe: [show(b)] }).hits.push(hit);
          }
        } else if (fixed.has(j)) resolved.add(i);
        break;
      }
      if (!resolved.has(i) && !worked.has(join(a))) {
        const k = join(a);
        const f = failing.get(k) ?? { shown: show(a), hits: [] };
        f.hits.push({ sessionId: id, step: s.n, at: s.at, lostSteps: 1, lostMs: activeMs(steps, i, i + 1), lostTokens: tokensFor(session, 1) });
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
      if (l.n < 2 || !(file === root || file.startsWith(root + path.sep))) continue;
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      const pass = steps.slice(l.last + 1).find((t) => t.kind === "command" && t.failed === false && VERIFY.test(t.command ?? ""));
      const end = pass ? steps.indexOf(pass) : l.last;
      const f = fragile.get(rel) ?? { verify: new Map<string, number>(), hits: [] };
      const v = pass ? mainCommand(pass.command ?? "") : null;
      if (v) { const shown = show(v); f.verify.set(shown, (f.verify.get(shown) ?? 0) + 1); }
      const lostSteps = steps.slice(l.first, end + 1).filter((t) => t.kind === "command" && t.failed === true).length + l.n;
      f.hits.push({ sessionId: id, step: steps[l.first]?.n ?? null, at: steps[l.first]?.at ?? null, lostSteps, lostMs: activeMs(steps, l.first, end), lostTokens: tokensFor(session, lostSteps) });
      fragile.set(rel, f);
    }

    for (const said of session.parsed.said) {
      const text = maskLaunch(said.text, home, 240);
      if (containsSecretLike(said.text)) continue;
      corrections.push({ sessionId: id, step: said.afterStep > 0 ? said.afterStep : null, at: said.at, text, words: words(text) });
    }
  }

  for (const [k, f] of failing) {
    if (new Set(f.hits.map((h) => h.sessionId)).size < 2 || f.hits.length < 3) continue;
    group(`failing:${k}`, { kind: "failing", title: `\`${f.shown}\` failed ${f.hits.length} times in ${new Set(f.hits.map((h) => h.sessionId)).size} sessions and was never fixed. Write down how to run it here.`, rule: null, probe: [] }).hits.push(...f.hits);
  }
  for (const [rel, f] of fragile) {
    const v = [...f.verify.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    group(`fragile:${rel}`, {
      kind: "fragile",
      title: `Agents broke and re-fixed \`${rel}\` in ${new Set(f.hits.map((h) => h.sessionId)).size} session${f.hits.length === 1 ? "" : "s"}.`,
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
      if (used.has(j) || d.sessionId === c.sessionId) return;
      if (jaccard(c.words, d.words) >= 0.4) { cluster.push(d); used.add(j); }
    });
    const sessions = new Set(cluster.map((x) => x.sessionId));
    if (sessions.size < 2) return;
    const best = [...cluster].sort((x, y) => x.text.length - y.text.length)[0]!;
    const said = new Set(cluster.flatMap((x) => [...x.words]));
    const same = [...groups.entries()].find(([k]) => { const m = /^program:(.+)>(.+)$/.exec(k); return m && said.has(m[1]!) && said.has(m[2]!); })?.[1];
    if (same) {
      same.title += ` You also told agents this yourself in ${sessions.size} sessions.`;
      return;
    }
    group(`said:${i}`, { kind: "correction", title: `You told agents this in ${sessions.size} sessions: “${best.text}”`, rule: ruleFromCorrection(best.text), probe: [...best.words] }).hits.push(...cluster.map((x) => ({ sessionId: x.sessionId, step: x.step, at: x.at, lostSteps: 0, lostMs: 0, lostTokens: 0 })));
  });

  return [...groups.values()];
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

export type LearnOptions = { root: string; since: Date; project?: ProjectLookup; requireProject?: boolean; instructionText?: string; limit?: number };

/** Reads past sessions that ran inside `root` and returns the lessons, most costly first. */
export async function learnLessons(ctx: SessionContext, opts: LearnOptions): Promise<LessonsReport> {
  const collected: Collected[] = [];
  const list = await listSessions(ctx, {
    since: opts.since, limit: opts.limit ?? 300, cwdWithin: opts.root, requireProject: opts.requireProject ?? false,
    ...(opts.project ? { project: opts.project } : {}),
    onLoaded: (session) => collected.push({ session, root: opts.root }),
  });
  const lessons: Lesson[] = analyze(collected, ctx.home)
    .filter((g) => g.kind !== "command" || g.hits.length >= 2 || g.title.includes("for example"))
    .map((g): Lesson => {
      const sessions = new Set(g.hits.map((h) => h.sessionId));
      const sum = (k: "lostSteps" | "lostMs" | "lostTokens"): number => g.hits.reduce((a, h) => a + h[k], 0);
      const key = `${g.kind}:${g.rule ?? g.title}`;
      return {
        id: `L-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`,
        kind: g.kind, title: g.title, rule: g.rule, times: g.hits.length, sessions: sessions.size,
        lostSteps: sum("lostSteps"), lostMs: sum("lostMs"), lostTokens: sum("lostTokens"),
        alreadyInFile: covered(g, opts.instructionText ?? ""),
        evidence: g.hits.slice(0, 6).map((h) => ({ sessionId: h.sessionId, step: h.step, at: h.at })),
      };
    })
    .sort((a, b) => b.lostMs - a.lostMs || b.times - a.times || a.id.localeCompare(b.id))
    .slice(0, 25);
  const agentMs = collected.reduce((a, c) => a + activeMs(c.session.parsed.steps, 0, c.session.parsed.steps.length - 1), 0);
  const agentTokens = collected.reduce((a, c) => a + (c.session.summary.metrics.tokens?.total ?? 0), 0);
  return {
    since: opts.since.toISOString(),
    sessionsRead: collected.length,
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
  const intro = "Rules learned from mistakes agents repeated in this project. Added after review with `agentsol learn`.";
  return { startLine: last + 1, endLine: last + 1, expectedText: lines[last] ?? "", replacementLines: [lines[last] ?? "", "", LESSONS_HEADING, "", intro, "", ...bullets] };
}
