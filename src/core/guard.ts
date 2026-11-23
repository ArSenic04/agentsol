/**
 * The guard: decides, before a shell command runs, whether an agent should run it as is (allow), run a
 * corrected version (deny with a fix), or check with the person first (ask). evaluate() is pure; the
 * helpers below it read only lockfiles, package.json and .git/HEAD.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { commandAdvice, type Lesson } from "./learn.ts";
import { commandRisks } from "./risks.ts";
import { containsSecretLike } from "./secrets.ts";
import { commandSegments, programName, strip } from "./sessions.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export const LOCKFILES: readonly [string, PackageManager][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
export type GuardLesson = Pick<Lesson, "id" | "kind" | "rule" | "title" | "times" | "sessions" | "match">;
export type GuardContext = {
  lessons?: readonly GuardLesson[];
  /** The package manager the nearest lockfile or packageManager field names; null when none or several. */
  packageManager?: { pm: PackageManager; why: string } | null;
  /** The checked-out branch, for force pushes that name no branch. */
  branch?: string | null;
  home?: string;
};
export type GuardRule = "package-manager" | "lesson" | "danger";
export type GuardResult = { decision: "allow" | "deny" | "ask"; reason: string; fix?: string; rules: GuardRule[] };

const PREFIX = "Agentsol guard:";
const LOCKFILE_SUBS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "test", "t", "run", "run-script", "start"]);
const SCRIPT_SUBS = new Set(["build", "lint", "dev"]);
const INSTALLS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "un"]);
const OTHER_DIR = /^(--prefix|-C|--dir|--cwd)(=|$)/;
const PROTECTED = /^(main|master|trunk|production|prod|release)$/;
const READERS = new Set(["cat", "less", "more", "head", "tail", "bat", "base64", "xxd", "od", "strings", "nl", "grep", "rg", "awk", "cp", "scp", "rsync", "tar", "zip", "gzip", "curl", "wget", "nc", "pbcopy", "open"]);
const CREDENTIAL = /(^|\/|=@?|@)\.ssh(\/(id_[\w-]+|[\w.-]+\.pem))?\/?$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)$|\.aws\/credentials$|(^|\/)\.(netrc|pypirc|git-credentials)$|(~|\$HOME|\$\{HOME\})\/\.npmrc$|\.docker\/config\.json$|\.kube\/config$|Library\/Keychains(\/|$)|\.config\/gcloud(\/|$)|\.gnupg(\/|$)|wallet\.dat$/;
const DOTENV = /(^|\/|=@?|@)\.env(\.(local|dev|development|prod|production|staging|test))?(\.local)?$/;
const DATABASES = new Set(["psql", "mysql", "sqlite3", "mongosh", "mongo", "redis-cli"]);

const noHeredocBodies = (c: string): string => c.replace(/(<<-?\s*(["']?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, "$1");
/** Commit messages, PR bodies and echoed text are data: `git commit -m "fix curl | sh"` runs nothing. */
const noMessages = (c: string): string => c.replace(/((?:^|\s)(?:-m|--message|--body|--title|-b|--notes|--description|echo|printf)(?:=|\s+))("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1""');
const shQuote = (w: string): string => (/^[\w./:=@%+,~^-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function packageManagerFix(pm: PackageManager, sub: string, args: readonly string[]): string {
  const pkgs = args.some((a) => !a.startsWith("-"));
  const flags = args.map((a) => (a === "--save-dev" || a === "--dev" ? "-D" : a)).filter((a) => a !== "--save" && a !== "-S" && !(pm === "npm" && (a === "--frozen-lockfile" || a === "--immutable")));
  const rest = flags.length ? ` ${flags.map(shQuote).join(" ")}` : "";
  if (sub === "ci" || (pm === "npm" && (sub === "install" || sub === "i") && args.some((a) => a === "--frozen-lockfile" || a === "--immutable"))) return pm === "npm" ? `npm ci${rest}` : `${pm} install --frozen-lockfile${rest}`;
  if (sub === "install" || sub === "i" || sub === "add") return pkgs || sub === "add" ? `${pm} ${pm === "npm" ? "install" : "add"}${rest}` : `${pm} install${rest}`;
  if (sub === "remove" || sub === "rm" || sub === "uninstall" || sub === "un") return `${pm} ${pm === "npm" ? "uninstall" : "remove"}${rest}`;
  if (sub === "test" || sub === "t") return `${pm} test${rest}`;
  if (sub === "start") return `${pm} start${rest}`;
  return `${pm} run${rest}`;
}

type Hit = { decision: "deny" | "ask"; rule: GuardRule; reason: string; fix?: string };

function packageManagerHits(command: string, ctx: GuardContext): Hit[] {
  const project = ctx.packageManager;
  if (!project) return [];
  const segs = commandSegments(noHeredocBodies(command));
  const out: Hit[] = [];
  for (const seg of segs) {
    const w = strip(seg);
    const head = programName(w[0] ?? "");
    // After `cd` the command runs in another folder, whose package manager this check does not know.
    if (head === "cd" || head === "pushd") break;
    if (head !== "npm" && head !== "pnpm" && head !== "yarn" && head !== "bun") continue;
    if (head === project.pm) continue;
    const args = w.slice(1);
    if (args.some((a) => a === "-g" || a === "--global" || a === "--location=global" || OTHER_DIR.test(a))) continue;
    const sub = args[0] ?? (head === "yarn" || head === "bun" ? "install" : "");
    const scriptLike = head !== "npm" && SCRIPT_SUBS.has(sub);
    if (!LOCKFILE_SUBS.has(sub) && !scriptLike) continue;
    const redirect = args.findIndex((a, i) => i > 0 && /^\d*[<>]/.test(a));
    const rest = args.slice(1, redirect > 0 ? redirect : undefined);
    const fixSeg = scriptLike ? runFix(project.pm, "run", [sub, ...rest]) : runFix(project.pm, sub, rest);
    // Swap only this command's words, up to any redirection, so the rest of the line stays as the agent wrote it.
    const words = args[0] === undefined ? "" : `\\s+${esc(args[0])}(?:\\s+(?!\\d*[<>])[^\\s;&|()<>]+)*`;
    const swapped = command.replace(new RegExp(`(^|[\\s;&|('"])${esc(w[0] ?? head)}${words}(?=\\s|$|[;&|)<>'"])`), (_m, pre: string) => `${pre}${fixSeg}`);
    const fix = [swapped !== command ? swapped : fixSeg, fixSeg, `${project.pm} ${sub}`].find((f) => !containsSecretLike(f))!;
    const lockfile = INSTALLS.has(sub);
    out.push({
      decision: "deny", rule: "package-manager", fix,
      reason: `this project uses ${project.pm} (${project.why}), so \`${head} ${args[0] ?? ""}\``.replace(/ `$/, "`") + (lockfile ? ` would create a second lockfile and install different versions.` : ` runs outside the project's package manager and can fail or use the wrong install.`),
    });
    break;
  }
  return out;
}
const runFix = (pm: PackageManager, sub: string, rest: readonly string[]): string => {
  if (sub === "run" || sub === "run-script") return `${pm} run${rest.length ? ` ${rest.map(shQuote).join(" ")}` : ""}`;
  return packageManagerFix(pm, sub, rest);
};

function lessonHits(command: string, ctx: GuardContext): Hit[] {
  if (!ctx.lessons?.length) return [];
  return commandAdvice(command, ctx.lessons).map((a) => {
    const fix = a.instead && !containsSecretLike(a.instead) ? a.instead : undefined;
    return a.verdict === "change" ? { decision: "deny" as const, rule: "lesson" as const, reason: `past sessions in this project: ${a.reason}`, ...(fix ? { fix } : {}) } : { decision: "ask" as const, rule: "lesson" as const, reason: `past sessions in this project: ${a.reason}` };
  });
}

function dangerHits(command: string, cwd: string, ctx: GuardContext): Hit[] {
  const text = noMessages(noHeredocBodies(command));
  const found = new Set<string>(commandRisks(text).map((w) => (w.startsWith("installs itself") ? "makes something run again later (shell startup file, cron, launch agent or git hook)" : w)));
  const home = ctx.home ? path.resolve(ctx.home) : null;
  const expand = (t: string): string => t.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home ?? "~");
  for (const seg of commandSegments(text)) {
    const w = strip(seg);
    const head = programName(w[0] ?? "");
    const args = w.slice(1);
    if (head === "rm" && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive")) {
      const targets = args.filter((a) => !a.startsWith("-"));
      const wide = targets.some((t) => {
        const abs = path.resolve(cwd, expand(t).replace(/\/\*$/, "") || "/");
        return abs === path.parse(abs).root || (home !== null && (abs === home || home.startsWith(abs + path.sep)));
      });
      if (wide) found.add("deletes the disk or home folder");
    } else if (head === "git") {
      const sub = args.find((a) => !a.startsWith("-")) ?? "";
      const after = args.slice(args.indexOf(sub) + 1);
      if (sub === "push") {
        const force = after.some((a) => a === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
        const refs = after.filter((a) => !a.startsWith("-")).slice(1);
        const named = refs.map((r) => r.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, ""));
        const plus = refs.some((r) => r.startsWith("+") && PROTECTED.test(named[refs.indexOf(r)] ?? ""));
        if (plus || (force && (named.some((r) => PROTECTED.test(r)) || (refs.length === 0 && PROTECTED.test(ctx.branch ?? ""))))) found.add(`force-pushes ${named.find((r) => PROTECTED.test(r)) ?? ctx.branch ?? "main"}, which rewrites history other people have pulled (use --force-with-lease on a feature branch)`);
      } else if (sub === "reset" && after.includes("--hard")) found.add("throws away uncommitted changes (git reset --hard)");
      else if (sub === "clean" && after.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force") && !after.some((a) => a === "-n" || a === "--dry-run")) found.add("deletes untracked files for good (git clean -f)");
      else if ((sub === "checkout" || sub === "restore") && after.filter((a) => a !== "--").length > 0 && after.filter((a) => a !== "--").every((a) => a === "." || a === "-f" || a === "--force" || a === "--worktree") && after.includes(".")) found.add(`throws away uncommitted changes (git ${sub} .)`);
      else if (sub === "stash" && after[0] === "clear") found.add("deletes every stash for good (git stash clear)");
    } else if (READERS.has(head)) {
      if (args.some((a) => CREDENTIAL.test(a.replace(/^-[A-Za-z]$/, "")) && !a.endsWith(".pub"))) found.add("reads a credential file (SSH key, cloud or package token); its secret would land in the session log or leave the machine");
      else if (head !== "cp" && args.some((a) => DOTENV.test(a))) found.add("prints secrets from a .env file into the session log; read .env.example, or ask the person which variable you need");
    } else if (DATABASES.has(head) && /\b(drop\s+(database|schema|table)|truncate\s+table|flushall|flushdb|dropDatabase)\b/i.test(args.join(" "))) found.add("deletes database data");
  }
  return [...found].map((what) => ({ decision: "ask" as const, rule: "danger" as const, reason: `this command ${what}.` }));
}

/** What to do with a shell command before it runs. Read-only and pure: every fact about the folder comes in ctx. */
export function evaluate(command: string, cwd: string, ctx: GuardContext = {}): GuardResult {
  const hits = [...packageManagerHits(command, ctx), ...lessonHits(command, ctx), ...dangerHits(command, cwd, ctx)];
  if (hits.length === 0) return { decision: "allow", reason: "", rules: [] };
  const rules = [...new Set(hits.map((h) => h.rule))];
  const deny = hits.filter((h) => h.decision === "deny");
  if (deny.length) {
    const fix = deny.find((h) => h.fix)?.fix;
    const asks = hits.filter((h) => h.decision === "ask");
    const reason = `${PREFIX} ${deny.map((h) => h.reason).join(" Also, ")}${fix ? ` Run instead: ${fix}` : ""}${asks.length ? ` Before running it, check with the person: ${asks.map((h) => h.reason).join(" ")}` : ""}`;
    return { decision: "deny", reason, ...(fix ? { fix } : {}), rules };
  }
  return { decision: "ask", reason: `${PREFIX} ${hits.map((h) => h.reason).join(" Also, ")} Confirm this is intended.`, rules };
}

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/** The nearest folder at or above cwd (below home) with a lockfile or a packageManager field, and what it names. */
export function packageManagerFor(cwd: string, home: string): { pm: PackageManager; why: string; dir: string } | null {
  const stop = path.resolve(home);
  for (let d = path.resolve(cwd); d !== stop && d !== path.dirname(d); d = path.dirname(d)) {
    const found: { pm: PackageManager; why: string }[] = [];
    for (const [file, pm] of LOCKFILES) if (isFile(path.join(d, file))) found.push({ pm, why: file });
    let declared: PackageManager | undefined;
    try { declared = /"packageManager"\s*:\s*"(npm|pnpm|yarn|bun)@/.exec(readFileSync(path.join(d, "package.json"), "utf8"))?.[1] as PackageManager | undefined; } catch { /* no package.json */ }
    if (declared) found.push({ pm: declared, why: "the packageManager field in package.json" });
    if (found.length === 0) continue;
    return new Set(found.map((f) => f.pm)).size === 1 ? { ...found[0]!, dir: d } : null;
  }
  return null;
}

/** The checked-out branch from .git/HEAD, or null (detached, worktree file, not a repo). */
export function gitBranch(cwd: string): string | null {
  for (let d = path.resolve(cwd); d !== path.dirname(d); d = path.dirname(d)) {
    try {
      return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(path.join(d, ".git", "HEAD"), "utf8"))?.[1]?.trim() ?? null;
    } catch {
      if (isFile(path.join(d, ".git"))) return null;
    }
  }
  return null;
}
