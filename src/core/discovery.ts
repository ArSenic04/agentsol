import { readdir } from "node:fs/promises";
import path from "node:path";
import { detectFormat, type SourceFormat } from "./formats.ts";
import type { FileMeta } from "./fileMeta.ts";
import { readFileInsideRoot } from "./fsSafe.ts";
import { sha256Hex } from "./hash.ts";
import { LIMITS } from "./limits.ts";
import { isSecretLikeDirName, isSecretLikeFileName } from "./secrets.ts";
import { decodeUtf8Strict } from "./text.ts";

/** Reasons a file with a supported instruction-file name was not read. */
export type ExclusionReason =
  | "symlink_not_followed"
  | "hard_link"
  | "personal_local_file"
  | "case_variant_name"
  | "changed_during_read"
  | "too_large"
  | "binary"
  | "invalid_utf8"
  | "not_regular_file"
  | "unreadable"
  | "limit_reached";

export type DiscoveredSource = {
  readonly relPath: string;
  readonly format: SourceFormat;
  readonly text: string;
  readonly rawSha256: string;
  readonly byteLength: number;
  /** Metadata at read time, for freshness hints only (never a correctness guard). */
  readonly meta: FileMeta;
};

/** Counts only: names of unrelated or secret-like entries are never recorded. */
export type SkippedCounts = {
  secretLike: number;
  symlinks: number;
  unreadableDirs: number;
  /** Directories such as node_modules, dist or build that are not walked. */
  skippedDirs: number;
  /** Directories deeper than LIMITS.maxDepth that were not walked. */
  depthLimited: number;
  limitReached: boolean;
};

export type DiscoveryResult = {
  readonly sources: DiscoveredSource[];
  /** Only entries whose name is a supported instruction file. */
  readonly exclusions: { relPath: string; reason: ExclusionReason }[];
  readonly skipped: SkippedCounts;
};

/** Directories that are never instruction scopes worth walking. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".hg", ".svn", "dist", "build", "out", ".next", ".turbo", ".venv", "venv",
  "__pycache__", ".cache", "target", "coverage", ".agentweave", ".local-workspace",
]);

const CASE_VARIANTS: ReadonlySet<string> = new Set(["agents.md", "agents.override.md", "claude.md", "claude.local.md", "skill.md"]);

/** Personal files that are usually gitignored; not read unless a later opt-in adds them. */
const PERSONAL_FORMATS: ReadonlySet<SourceFormat> = new Set(["claude-local-md"]);

/**
 * Walks a project root (already verified) and reads only files whose names match a
 * supported instruction format. Symlinks are never followed, hard-linked files are not
 * read, secret-like names and directories are never opened, and only instruction-file
 * names are ever recorded (other names are counted, not listed).
 */
export async function discover(rootReal: string): Promise<DiscoveryResult> {
  const sources: DiscoveredSource[] = [];
  const exclusions: { relPath: string; reason: ExclusionReason }[] = [];
  const skipped: SkippedCounts = { secretLike: 0, symlinks: 0, unreadableDirs: 0, skippedDirs: 0, depthLimited: 0, limitReached: false };
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  let entriesSeen = 0;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    let entries;
    try {
      entries = await readdir(path.join(rootReal, next.rel), { withFileTypes: true });
    } catch {
      skipped.unreadableDirs += 1;
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      entriesSeen += 1;
      const rel = next.rel ? `${next.rel}/${entry.name}` : entry.name;
      const format = detectFormat(rel);
      if (entriesSeen > LIMITS.maxDirEntries) {
        skipped.limitReached = true;
        return { sources, exclusions, skipped };
      }
      if (entry.isSymbolicLink()) {
        if (format) exclusions.push({ relPath: rel, reason: "symlink_not_followed" });
        else skipped.symlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (isSecretLikeDirName(entry.name)) skipped.secretLike += 1;
        else if (SKIP_DIRS.has(entry.name)) skipped.skippedDirs += 1;
        else if (next.depth + 1 > LIMITS.maxDepth) skipped.depthLimited += 1;
        else queue.push({ rel, depth: next.depth + 1 });
        continue;
      }
      if (!format) {
        if (isSecretLikeFileName(entry.name)) skipped.secretLike += 1;
        // agents.md / Claude.md: case-insensitive filesystems (macOS default) let clients
        // open these as AGENTS.md / CLAUDE.md. AgentWeave does not read them; it reports them.
        else if (CASE_VARIANTS.has(entry.name.toLowerCase())) exclusions.push({ relPath: rel, reason: "case_variant_name" });
        continue;
      }
      if (PERSONAL_FORMATS.has(format)) {
        exclusions.push({ relPath: rel, reason: "personal_local_file" });
        continue;
      }
      if (!entry.isFile()) {
        exclusions.push({ relPath: rel, reason: "not_regular_file" });
        continue;
      }
      if (sources.length >= LIMITS.maxSources) {
        exclusions.push({ relPath: rel, reason: "limit_reached" });
        continue;
      }
      const read = await readFileInsideRoot(rootReal, rel, LIMITS.maxFileBytes);
      if (!read.ok) {
        const reason: ExclusionReason =
          read.error.code === "too_large" ? "too_large"
          : read.error.code === "symlink" ? "symlink_not_followed"
          : read.error.code === "hard_link" ? "hard_link"
          : read.error.code === "swapped" ? "changed_during_read"
          : read.error.code === "not_regular_file" ? "not_regular_file"
          : "unreadable";
        exclusions.push({ relPath: rel, reason });
        continue;
      }
      const decoded = decodeUtf8Strict(read.value.bytes);
      if (!decoded.ok) {
        exclusions.push({ relPath: rel, reason: decoded.error.code });
        continue;
      }
      sources.push({ relPath: rel, format, text: decoded.value, rawSha256: sha256Hex(read.value.bytes), byteLength: read.value.bytes.length, meta: read.value.meta });
    }
  }
  return { sources, exclusions, skipped };
}
