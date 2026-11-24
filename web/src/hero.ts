import { h } from "./dom.ts";

/**
 * The hero: an agent session replayed as text. The briefing and the block are what the guard hook
 * returns for this case; the session itself is illustrative, not a recording of an assistant app.
 * Lines fade in once; reduced motion shows them all at once.
 */
type Kind = "user" | "call" | "ok" | "warn" | "poss" | "wait";
const ICON: Record<Kind, string> = { user: "›", call: "⏺", ok: "✓", warn: "!", poss: "?", wait: "⏸" };

const SESSION: readonly (readonly [Kind, string, string?])[] = [
  ["ok", "Session start · agentsol briefing added", "use pnpm, not npm: npm failed here 3×"],
  ["user", "Fix the failing date test, then run the tests."],
  ["call", "Edit", "src/date.ts"],
  ["call", "Bash", "npm test"],
  ["warn", "Blocked by agentsol guard: npm failed here 3 times, pnpm worked → pnpm test"],
  ["call", "Bash", "pnpm test"],
  ["ok", "42 tests passed"],
  ["poss", "AGENTS.md:3 still says npm test · fix proposed as a diff, not applied"],
  ["wait", "Your turn: agentsol review <proposalId>"],
]

function line([kind, text, arg]: readonly [Kind, string, string?]): HTMLElement {
  return h("li", { class: `term-line t-${kind}` },
    h("span", { class: "t-ico" }, ICON[kind]),
    h("span", { class: kind === "wait" ? "t-cursor" : "" }, text, arg ? h("span", { class: "t-arg" }, ` (${arg})`) : null));
}

export function heroDiagram(): HTMLElement {
  return h("figure", { class: "hero-art" },
    h("div", { class: "term", attrs: { "aria-hidden": "true" } },
      h("div", { class: "term-bar" }, h("span", { class: "term-dot" }), h("span", { class: "term-dot" }), h("span", { class: "term-dot" }), h("span", { class: "term-title" }, "your agent + agentsol")),
      h("ol", { class: "term-body" }, ...SESSION.map(line))),
    h("figcaption", { class: "legend" },
      h("span", { class: "sr-only" }, "Illustration of an agent session: at session start Agentsol adds the project's lessons, the agent's npm test is blocked with the command that works, the agent runs pnpm test and the tests pass, and the fix to the out-of-date instruction line waits for you to approve. "),
      h("span", { class: "legend-item" }, h("span", { class: "swatch", attrs: { "aria-hidden": "true" } }), "Illustrative session: the briefing and the block are Agentsol\u2019s real hook output"),
      h("span", { class: "legend-item" }, h("span", { class: "swatch swatch-dashed", attrs: { "aria-hidden": "true" } }), "Ran live in Claude Code; the other apps\u2019 hook formats are tested, not yet run live")));
}

type C = "sun" | "agent" | "ok" | "bad" | "warn" | "info" | "muted" | "bold" | "";
type Run = readonly [C, string];

const runs = (row: readonly Run[]): HTMLElement => h("span", { class: "cli-line" }, ...row.map(([c, t]) => (c ? h("span", { class: `c-${c}` }, t) : t)), "\n");

const BOX = 62;
const ltop = (title: string): Run[] => [["", "  ╭─ "], ["bold", title], ["", ` ${"─".repeat(BOX - title.length - 3)}╮`]];
const lrow = (...parts: Run[]): Run[] => [["", "  │ "], ...parts, ["", `${" ".repeat(Math.max(0, BOX - 1 - parts.reduce((n, p) => n + p[1].length, 0)))}│`]];
const lend: Run[] = [["", `  ╰${"─".repeat(BOX)}╯`]];

/** `agentsol learn` on three synthetic Claude Code and Codex transcripts, transcribed from a real run. */
const LEARN: readonly (readonly Run[])[] = [
  [["sun", "◉ "], ["bold", "agentsol learn  "], ["muted", "my-app · since 5/19/2026 · 3 sessions read"]],
  [],
  ltop("What repeated mistakes cost"),
  lrow(["muted", "Time lost     "], ["bold", "24m"], ["muted", " of 29m active agent time (82%)"]),
  lrow(["muted", "Tokens lost   "], ["bold", "17k"], ["muted", " of 26k · 15 wasted steps"]),
  lrow(["muted", "Lessons       "], ["", "3 · "], ["bad", "1 wrong instruction"], ["", " · "], ["ok", "2 new rules"]),
  lend,
  [],
  [["muted", "    1  "], ["bad", "fragile "], ["muted", "  3× in 3 sessions · 20m lost"]],
  [["", "         Agents broke and re-fixed `src/billing/invoice.ts` in 3 sessions."]],
  [["ok", "         rule  → "], ["bold", "After changing `src/billing/invoice.ts`, run"]],
  [["bold", "                 `pnpm test billing` before moving on."]],
  [["muted", "         seen in claude-015036e44317 step 3 · claude-3f070fb82352 step 3 · …"]],
  [],
  [["muted", "    2  "], ["warn", "command "], ["muted", "  3× in 3 sessions · 4m lost"]],
  [["", "         Your instructions tell agents to do this (AGENTS.md:7)."]],
  [["", "         Agents use `npm` here, which fails; `pnpm` works (for example"]],
  [["", "         `pnpm test`)."]],
  [["muted", "         AGENTS.md line 7"]],
  [["muted", "         now   "], ["bad", "− - Run `npm test` before every commit."]],
  [["muted", "         fix   "], ["ok", "+ - Run `pnpm test` before every commit."]],
  [["muted", "         seen in claude-015036e44317 step 1 · codex-3f070fb82352 step 1 · …"]],
  [],
  [["muted", "    3  "], ["sun", "you said"], ["muted", "  2× in 2 sessions"]],
  [["", "         You told agents this in 2 sessions: “never edit the generated files"]],
  [["", "         in gen/, run pnpm codegen”"]],
  [["ok", "         rule  → "], ["bold", "Never edit the generated files in gen/, run pnpm codegen."]],
  [["muted", "         seen in claude-3f070fb82352 step 2 · claude-a9e7b10d15f3 step 2"]],
  [],
  ltop("Next"),
  lrow(["agent", "1 "], ["", "1 correction and 2 new rules in AGENTS.md:"]),
  lrow(["agent", "  "], ["bold", "npx -y agentsol@alpha learn --propose"]),
  lrow(["muted", "  you read the diff, then approve and apply it yourself"]),
  lrow(["agent", "2 "], ["", "Or ask your AI:  "], ["sun", "“Use agentsol learn.”"]),
  lrow(["agent", "  "], ["muted", "in Claude Code: "], ["bold", "/mcp__agentsol__learn"], ["muted", " · run it weekly"]),
  lend,
  [],
  [["muted", "  Read from transcripts on this machine. Nothing was sent anywhere, and no project file was changed."]],
];

/** `agentsol start` on a synthetic project with three past Claude Code sessions, transcribed from a real run. */
const START: readonly (readonly Run[])[] = [
  [["sun", "◉ "], ["bold", "agentsol start  "], ["muted", "~/code/my-app"]],
  [],
  [["ok", "  ✓ "], ["bold", "Project      "], ["", "registered my-app"], ["muted", " · 1 instruction file · "], ["ok", "no problems"]],
  [["agent", "  ? "], ["", "Connect agentsol to Claude Code? It runs "], ["bold", "claude mcp add"], ["muted", " (adds it to your user config)"], ["", " [Y/n] "], ["bold", "y"]],
  [["ok", "  ✓ "], ["bold", "Your AI      "], ["", "Claude Code"], ["muted", " · "], ["ok", "connected now"]],
  [["warn", "  ▲ "], ["bold", "Agent work   "], ["", "3 sessions"], ["muted", " · "], ["warn", "24m lost to repeat mistakes"], ["muted", " · "], ["ok", "none risky"]],
  [["ok", "  ✓ "], ["bold", "AI settings  "], ["ok", "nothing risky"]],
  [],
  ltop("Next"),
  lrow(["agent", "1 "], ["", "Stop 3 repeated mistakes:"]),
  lrow(["agent", "  "], ["bold", "npx -y agentsol@alpha learn --propose"]),
  lrow(["agent", "  "], ["muted", "adds the rules to your instruction file after you approve"]),
  lrow(["agent", "2 "], ["", "Restart your AI app, then ask:  "], ["sun", "“Use agentsol to audit"]),
  lrow(["agent", "  "], ["sun", "this project.”"]),
  lrow(["agent", "  "], ["muted", "in Claude Code: "], ["bold", "/mcp__agentsol__audit"], ["muted", " · "], ["bold", "/mcp__agentsol__learn"]),
  lend,
  [],
  [["muted", "  Nothing in your project was changed. Agentsol only reads; you approve every edit."]],
];

export function startShowcase(): HTMLElement {
  return h("figure", { class: "cli-art" },
    h("div", { class: "term" },
      h("div", { class: "term-bar" }, h("span", { class: "term-dot" }), h("span", { class: "term-dot" }), h("span", { class: "term-dot" }), h("span", { class: "term-title" }, "~/code/my-app — npx -y agentsol@alpha start")),
      h("pre", { class: "cli", attrs: { tabindex: "0", role: "region", "aria-label": "Example agentsol start run in a terminal" } }, ...START.map(runs))),
    h("figcaption", { class: "legend" }, h("span", { class: "legend-item" }, "Transcribed from a real run on a synthetic project. It only connects apps you have installed, and only after you answer yes.")));
}

export function learnShowcase(): HTMLElement {
  return h("figure", { class: "cli-art" },
    h("div", { class: "term" },
      h("div", { class: "term-bar" }, h("span", { class: "term-dot" }), h("span", { class: "term-dot" }), h("span", { class: "term-dot" }), h("span", { class: "term-title" }, "~/code/my-app — npx -y agentsol@alpha learn")),
      h("pre", { class: "cli", attrs: { tabindex: "0", role: "region", "aria-label": "Example agentsol learn report in a terminal" } }, ...LEARN.map(runs))),
    h("figcaption", { class: "legend" }, h("span", { class: "legend-item" }, "Transcribed from a real run on three synthetic transcripts, with long lines wrapped. Your numbers come from your own sessions.")));
}
