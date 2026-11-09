export const LIMITS = {
  /** Instruction files above this size are excluded, not truncated. */
  maxFileBytes: 256 * 1024,
  maxDepth: 16,
  maxDirEntries: 50_000,
  maxSources: 500,
  /** source_read returns at most this many lines / characters per call. */
  maxReadLines: 400,
  maxReadChars: 64 * 1024,
} as const;
