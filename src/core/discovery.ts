import { readdir } from "node:fs/promises";
import path from "node:path";
import { detectFormat, type SourceFormat } from "./formats.ts";
import { readRegularFileNoFollow } from "./fsSafe.ts";
import { sha256Hex } from "./hash.ts";
import { LIMITS } from "./limits.ts";
import { isSecretLikeFileName, SECRET_DIR_NAMES } from "./secrets.ts";
import { decodeUtf8Strict } from "./text.ts";

export type ExclusionReason =
  | "symlink_not_followed"
  | "secret_like_name"
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
};

export type DiscoveryResult = {
  readonly sources: DiscoveredSource[];
  readonly exclusions: { relPath: string; reason: ExclusionReason }[];
};

/** Directories that are never instruction scopes worth walking. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".hg", ".svn", "dist", "build", "out", ".next", ".turbo", ".venv", "venv",
  "__pycache__", ".cache", "target", "coverage", ".agentweave", ".local-workspace",
]);

/**
 * Walks a project root (already realpath'd) and reads only files whose names match a
 * supported instruction format. Symlinks are never followed; secret-like names and
 * directories are never read; oversize, binary and non-UTF-8 files are excluded.
 */
export async function discover(rootReal: string): Promise<DiscoveryResult> {
  const sources: DiscoveredSource[] = [];
  const exclusions: { relPath: string; reason: ExclusionReason }[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  let entriesSeen = 0;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const absDir = path.join(rootReal, next.rel);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      exclusions.push({ relPath: next.rel || ".", reason: "unreadable" });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      entriesSeen += 1;
      const rel = next.rel ? `${next.rel}/${entry.name}` : entry.name;
      if (entriesSeen > LIMITS.maxDirEntries) {
        exclusions.push({ relPath: rel, reason: "limit_reached" });
        return { sources, exclusions };
      }
      if (entry.isSymbolicLink()) {
        exclusions.push({ relPath: rel, reason: "symlink_not_followed" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SECRET_DIR_NAMES.has(entry.name)) exclusions.push({ relPath: rel, reason: "secret_like_name" });
        else if (!SKIP_DIRS.has(entry.name) && next.depth + 1 <= LIMITS.maxDepth) queue.push({ rel, depth: next.depth + 1 });
        continue;
      }
      const format = detectFormat(rel);
      if (isSecretLikeFileName(entry.name)) {
        exclusions.push({ relPath: rel, reason: "secret_like_name" });
        continue;
      }
      if (!format) continue;
      if (!entry.isFile()) {
        exclusions.push({ relPath: rel, reason: "not_regular_file" });
        continue;
      }
      if (sources.length >= LIMITS.maxSources) {
        exclusions.push({ relPath: rel, reason: "limit_reached" });
        continue;
      }
      const read = await readRegularFileNoFollow(path.join(rootReal, rel), LIMITS.maxFileBytes);
      if (!read.ok) {
        const reason: ExclusionReason =
          read.error.code === "too_large" ? "too_large"
          : read.error.code === "symlink" ? "symlink_not_followed"
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
      sources.push({
        relPath: rel,
        format,
        text: decoded.value,
        rawSha256: sha256Hex(read.value.bytes),
        byteLength: read.value.bytes.length,
      });
    }
  }
  return { sources, exclusions };
}
