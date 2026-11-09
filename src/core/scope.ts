import path from "node:path";
import { scopeDirOf, type SourceFormat } from "./formats.ts";
import type { SourceId } from "./ids.ts";
import { normalizeRelPath, type PathError } from "./paths.ts";
import { ok, type Result } from "./result.ts";

export const PLATFORMS = ["codex", "claude-code", "cursor"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** sourceId is null for files AgentWeave knows exist but does not read (CLAUDE.local.md). */
export type ScopeSource = { sourceId: SourceId | null; relPath: string; format: SourceFormat; empty: boolean };
export type ChainEntry = { order: number; sourceId: SourceId | null; relPath: string; format: SourceFormat; when: "launch" | "on_demand"; reason: string };
export type ScopeResolution = {
  platform: Platform;
  targetPath: string;
  workingDirectory: string;
  /** Launch files first, then files loaded on demand when the client reads files below the working directory. */
  chain: ChainEntry[];
  /** Overlapping scopes are layered context, never treated as conflicts by AgentWeave. */
  relationship: "layered";
  /** Always partial: user, managed, rule and IDE files are outside AgentWeave's view. */
  coverage: "partial";
  assumptions: string[];
  notInspected: string[];
};

const dirsFromRootTo = (dir: string): string[] => {
  const parts = dir === "" ? [] : dir.split("/");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
};
const dirOfFile = (rel: string): string => {
  const d = path.posix.dirname(rel);
  return d === "." ? "" : d;
};

/**
 * Ordered project instruction files a client would load, following each vendor's
 * documented default behavior as of Nov 2026, for a session started in
 * `workingDirectory` that works on `targetPath`. This is a model of documented
 * defaults, not an observation of a running client.
 */
export function resolveScope(args: { sources: readonly ScopeSource[]; targetPath: string; platform: Platform; workingDirectory?: string }): Result<ScopeResolution, PathError> {
  const norm = normalizeRelPath(args.targetPath);
  if (!norm.ok) return norm;
  let cwd = "";
  if (args.workingDirectory !== undefined && args.workingDirectory !== "" && args.workingDirectory !== ".") {
    const w = normalizeRelPath(args.workingDirectory);
    if (!w.ok) return w;
    cwd = w.value;
  }
  const targetDir = dirOfFile(norm.value);
  const launchDirs = dirsFromRootTo(cwd);
  const belowCwd = targetDir === cwd || targetDir.startsWith(`${cwd}/`) || cwd === "";
  const onDemandDirs = belowCwd ? dirsFromRootTo(targetDir).filter((d) => !launchDirs.includes(d)) : [];
  const inDir = (dir: string, format: SourceFormat): ScopeSource[] =>
    args.sources.filter((s) => s.format === format && !s.empty && scopeDirOf(s.relPath, s.format) === dir);
  const picked: Omit<ChainEntry, "order">[] = [];
  const add = (s: ScopeSource, when: ChainEntry["when"], reason: string) => picked.push({ sourceId: s.sourceId, relPath: s.relPath, format: s.format, when, reason });
  const assumptions: string[] = [`Session started in ${cwd === "" ? "the registered project folder" : cwd}; pass workingDirectory to change this.`];
  const notInspected: string[] = [];

  switch (args.platform) {
    case "codex": {
      for (const dir of launchDirs) {
        const override = inDir(dir, "agents-override-md")[0];
        const agents = inDir(dir, "agents-md")[0];
        if (override) add(override, "launch", "AGENTS.override.md wins in its directory");
        else if (agents) add(agents, "launch", "AGENTS.md for this directory");
      }
      assumptions.push("Codex walks from the project root it detects (usually the Git root) to the working directory; that root may differ from the registered folder.");
      assumptions.push("Instruction files below the working directory are not loaded automatically.");
      assumptions.push("Codex stops adding files once the combined size reaches project_doc_max_bytes (32 KiB by default).");
      notInspected.push("~/.codex/AGENTS.md and AGENTS.override.md", "project_doc_fallback_filenames and other config.toml settings");
      break;
    }
    case "claude-code": {
      const counts = (d: string) => inDir(d, "claude-md").length > 0 || inDir(d, "claude-local-md").length > 0;
      const claudeAtOrAbove = launchDirs.some(counts);
      for (const dir of launchDirs) {
        if (claudeAtOrAbove) {
          for (const s of inDir(dir, "claude-md")) add(s, "launch", "CLAUDE.md at or above the working directory");
          for (const s of inDir(dir, "claude-local-md")) add(s, "launch", "CLAUDE.local.md is appended after CLAUDE.md (AgentWeave does not read it)");
        } else {
          for (const s of inDir(dir, "agents-md")) add(s, "launch", "No CLAUDE.md at or above the working directory, so the default setting reads AGENTS.md");
        }
      }
      for (const dir of onDemandDirs) {
        const claudeHere = inDir(dir, "claude-md");
        for (const s of claudeHere) add(s, "on_demand", "Subdirectory CLAUDE.md, loaded when Claude reads files there");
        if (!claudeAtOrAbove && !counts(dir)) for (const s of inDir(dir, "agents-md")) add(s, "on_demand", "Subdirectory AGENTS.md, loaded when Claude reads files there (default setting)");
      }
      assumptions.push("Uses the default Project instructions setting (claude-md-or-agents-md) and Claude Code v2.1.277 or later; older versions read only CLAUDE.md.");
      assumptions.push("CLAUDE.md files above the registered folder also load and are not inspected.");
      notInspected.push("~/.claude/CLAUDE.md, managed policy CLAUDE.md, .claude/rules/, auto memory", "@imports are listed by check D09 but not expanded here", ".claude/AGENTS.md");
      break;
    }
    case "cursor": {
      for (const dir of dirsFromRootTo(targetDir)) for (const s of inDir(dir, "agents-md")) add(s, "launch", "AGENTS.md (nested files combine with parents)");
      assumptions.push("Treats nested AGENTS.md files as applying to files in their directory.");
      notInspected.push(".cursor/rules (.mdc), User and Team rules, CLAUDE.md compatibility settings");
      break;
    }
    default: {
      const exhaustive: never = args.platform;
      return exhaustive;
    }
  }
  notInspected.push("SKILL.md files load by relevance and are not part of this ordered chain");
  return ok({
    platform: args.platform,
    targetPath: norm.value,
    workingDirectory: cwd,
    chain: picked.map((p, i) => ({ ...p, order: i + 1 })),
    relationship: "layered",
    coverage: "partial",
    assumptions,
    notInspected,
  });
}

export const isPlatform = (v: unknown): v is Platform => typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
