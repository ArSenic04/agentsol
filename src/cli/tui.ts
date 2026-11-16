/**
 * Terminal rendering with no dependencies: a gradient banner, rounded panels, chips and a
 * spinner. Every text segment is sanitized before styling, so untrusted file text can never
 * inject escape codes; only this module emits them. Honors NO_COLOR, FORCE_COLOR and TERM=dumb.
 */
import { sanitizeForTerminal } from "../core/display.ts";

export type Style = "dim" | "bold" | "sun" | "sun2" | "agent" | "bad" | "warn" | "ok" | "info" | "muted";
export type Seg = string | readonly [Style, string];
export type Term = { color: boolean; truecolor: boolean; width: number; tty: boolean };

export function detectTerm(stream: { isTTY?: boolean; columns?: number }, env: NodeJS.ProcessEnv): Term {
  const tty = Boolean(stream.isTTY);
  const forced = env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0";
  const color = forced || (tty && !env["NO_COLOR"] && env["TERM"] !== "dumb");
  const truecolor = color && (/truecolor|24bit/i.test(env["COLORTERM"] ?? "") || env["TERM_PROGRAM"] === "iTerm.app" || env["TERM_PROGRAM"] === "vscode" || env["TERM_PROGRAM"] === "WezTerm");
  return { color, truecolor, tty, width: Math.max(40, Math.min(stream.columns || Number(env["COLUMNS"]) || 80, 110)) };
}

type Rgb = readonly [number, number, number];
const RGB: Record<Exclude<Style, "dim" | "bold">, Rgb> = {
  sun: [255, 209, 102], sun2: [255, 107, 61], agent: [94, 234, 212], bad: [255, 107, 107],
  warn: [255, 181, 71], ok: [94, 234, 212], info: [125, 211, 252], muted: [140, 150, 170],
};
const BASIC: Record<Exclude<Style, "dim" | "bold">, number> = { sun: 33, sun2: 31, agent: 36, bad: 31, warn: 33, ok: 32, info: 34, muted: 90 };
const fg = (t: Term, c: Rgb, basic: number): string => (t.truecolor ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[${basic}m`);
const sgr = (t: Term, s: Style): string => (s === "dim" ? "\x1b[2m" : s === "bold" ? "\x1b[1m" : fg(t, RGB[s], BASIC[s]));
const RESET = "\x1b[0m";

export function render(t: Term, segs: readonly Seg[]): string {
  return segs.map((s) => {
    if (typeof s === "string") return sanitizeForTerminal(s);
    const text = sanitizeForTerminal(s[1]);
    return t.color && text ? `${sgr(t, s[0])}${text}${RESET}` : text;
  }).join("");
}

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleWidth = (s: string): number => [...s.replace(ANSI, "")].length;

/** Cuts segments to a visible width, ending with an ellipsis when something was dropped. */
export function fit(segs: readonly Seg[], max: number): Seg[] {
  const out: Seg[] = [];
  let left = max;
  for (const s of segs) {
    const text = typeof s === "string" ? s : s[1];
    const chars = [...sanitizeForTerminal(text)];
    if (chars.length <= left) { out.push(s); left -= chars.length; continue; }
    const cut = `${chars.slice(0, Math.max(0, left - 1)).join("")}…`;
    out.push(typeof s === "string" ? cut : [s[0], cut]);
    break;
  }
  return out;
}

const mix = (a: Rgb, b: Rgb, f: number): Rgb => [0, 1, 2].map((i) => Math.round((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * f)) as unknown as Rgb;
const STOPS: readonly Rgb[] = [[255, 209, 102], [255, 154, 82], [255, 107, 61]];
function gradientAt(f: number): Rgb {
  const x = Math.min(0.9999, Math.max(0, f)) * (STOPS.length - 1);
  const i = Math.floor(x);
  return mix(STOPS[i] ?? STOPS[0]!, STOPS[i + 1] ?? STOPS[i]!, x - i);
}

const GLYPHS: Record<string, readonly string[]> = {
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
};
const WORD = "AGENTSOL";
const ART: readonly string[] = [0, 1, 2, 3, 4, 5].map((row) => [...WORD].map((ch) => GLYPHS[ch]?.[row] ?? "").join(""));
export const BANNER_WIDTH = [...(ART[0] ?? "")].length;

/** Block-letter wordmark: sun gradient on the faces, agent teal on the shadows. Falls back to one line on narrow terminals. */
export function banner(t: Term): string[] {
  if (t.width < BANNER_WIDTH + 4) return [render(t, [["sun", "  ◉ "], ["bold", "AGENTSOL"]])];
  return ART.map((row) => {
    const chars = [...row];
    if (!t.color) return `  ${row}`;
    return `  ${chars.map((c, i) => {
      if (c === " ") return c;
      if (c === "█") return `${fg(t, gradientAt(i / chars.length), 33)}${c}`;
      return `${fg(t, [47, 143, 134], 36)}${c}`;
    }).join("")}${RESET}`;
  });
}

/** Rounded panel. Rows wider than the panel are cut with an ellipsis. */
export function panel(t: Term, title: readonly Seg[], rows: readonly (readonly Seg[])[], width = t.width - 2): string[] {
  const inner = Math.max(20, width - 4);
  const b = (s: string): string => render(t, [["agent", s]]);
  const head = render(t, fit(title, inner - 2));
  const top = `${b("╭─ ")}${head}${b(` ${"─".repeat(Math.max(0, inner - visibleWidth(head) - 1))}╮`)}`;
  const body = rows.map((r) => {
    const text = render(t, fit(r, inner));
    return `${b("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${b("│")}`;
  });
  return [top, ...body, b(`╰${"─".repeat(inner + 2)}╯`)];
}

/** Label/value rows with the labels padded to one column. */
export function pairs(items: readonly (readonly [string, readonly Seg[]])[], labelWidth = 0): Seg[][] {
  const w = Math.max(labelWidth, ...items.map(([k]) => k.length + 2));
  return items.map(([k, v]) => [["muted", k.padEnd(w)], ...v]);
}

/** Splits words into rows no wider than max. */
export function wrapWords(words: readonly string[], max: number, sep = "  "): string[] {
  const rows: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + sep.length + w.length > max) { rows.push(cur); cur = w; } else cur = cur ? `${cur}${sep}${w}` : w;
  }
  if (cur) rows.push(cur);
  return rows;
}

export const heading = (t: Term, text: string, extra: readonly Seg[] = []): string => render(t, [["sun", "◆ "], ["bold", text], ...(extra.length ? ["  ", ...extra] : [])]);

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** Shows a spinner on interactive color terminals while work runs; prints nothing otherwise. */
export async function withSpinner<T>(t: Term, label: string, work: () => Promise<T>): Promise<T> {
  if (!t.tty || !t.color) return work();
  let i = 0;
  const draw = (): void => { process.stdout.write(`\r${render(t, [["agent", FRAMES[i++ % FRAMES.length] ?? "·"], ` ${label}`])}`); };
  draw();
  const timer = setInterval(draw, 80);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K");
  }
}
