import path from "node:path";
import { scopeDirOf, type SourceFormat } from "./formats.ts";
import type { SourceId } from "./ids.ts";
import { normalizeRelPath, type PathError } from "./paths.ts";
import { ok, type Result } from "./result.ts";

export const PLATFORMS = ["codex", "claude-code", "cursor"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type ScopeSource = { sourceId: SourceId; relPath: string; format: SourceFormat; empty: boolean };
export type ChainEntry = { order: number; sourceId: SourceId; relPath: string; format: SourceFormat; reason: string };
export type ScopeResolution = {
  platform: Platform;
  targetPath: string;
  chain: ChainEntry[];
  /** Overlapping scopes are layered context, never treated as conflicts by AgentWeave. */
  relationship: "layered";
  notes: string[];
};

const ancestorDirs = (targetPath: string): string[] => {
  const dir = path.posix.dirname(targetPath);
  const parts = dir === "." ? [] : dir.split("/");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
};

/**
 * Ordered list of project instruction files a client would load for a file at
 * `targetPath`, following each vendor's documented rules. Files outside the project
 * (home directory, managed policy) are out of scope and called out in notes.
 */
export function resolveScope(args: { sources: readonly ScopeSource[]; targetPath: string; platform: Platform }): Result<ScopeResolution, PathError> {
  const norm = normalizeRelPath(args.targetPath);
  if (!norm.ok) return norm;
  const dirs = ancestorDirs(norm.value);
  const inDir = (dir: string, format: SourceFormat): ScopeSource[] =>
    args.sources.filter((s) => s.format === format && !s.empty && scopeDirOf(s.relPath, s.format) === dir);
  const picked: { s: ScopeSource; reason: string }[] = [];
  const notes: string[] = [];

  switch (args.platform) {
    case "codex": {
      for (const dir of dirs) {
        const override = inDir(dir, "agents-override-md")[0];
        const agents = inDir(dir, "agents-md")[0];
        if (override) picked.push({ s: override, reason: "AGENTS.override.md wins in its directory" });
        else if (agents) picked.push({ s: agents, reason: "AGENTS.md for this directory" });
      }
      notes.push("Codex also reads ~/.codex/AGENTS(.override).md first; files outside the project are not inspected.");
      notes.push("Codex concatenates root to leaf; later files appear later in the prompt. Combined size stops at 32 KiB by default.");
      break;
    }
    case "claude-code": {
      const hasClaude = dirs.some((d) => inDir(d, "claude-md").length > 0 || inDir(d, "claude-local-md").length > 0);
      for (const dir of dirs) {
        if (hasClaude) {
          for (const s of inDir(dir, "claude-md")) picked.push({ s, reason: "CLAUDE.md for this directory" });
          for (const s of inDir(dir, "claude-local-md")) picked.push({ s, reason: "CLAUDE.local.md is appended after CLAUDE.md" });
        } else {
          for (const s of inDir(dir, "agents-md")) picked.push({ s, reason: "No CLAUDE.md applies, so Claude Code reads AGENTS.md (default setting)" });
        }
      }
      notes.push("Uses Claude Code's default Project instructions setting (claude-md-or-agents-md).");
      notes.push("Managed policy, ~/.claude/CLAUDE.md, .claude/rules and files above the project root are not inspected.");
      break;
    }
    case "cursor": {
      for (const dir of dirs) for (const s of inDir(dir, "agents-md")) picked.push({ s, reason: "AGENTS.md (nested files combine with parents)" });
      notes.push(".cursor/rules (.mdc) and User/Team rules are not supported by AgentWeave yet.");
      break;
    }
    default: {
      const exhaustive: never = args.platform;
      return exhaustive;
    }
  }
  notes.push("Skills (SKILL.md) load by relevance and are not part of this ordered chain.");
  return ok({
    platform: args.platform,
    targetPath: norm.value,
    chain: picked.map((p, i) => ({ order: i + 1, sourceId: p.s.sourceId, relPath: p.s.relPath, format: p.s.format, reason: p.reason })),
    relationship: "layered",
    notes,
  });
}

export const isPlatform = (v: unknown): v is Platform => typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
