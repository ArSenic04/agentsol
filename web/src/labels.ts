/** Plain-language labels for codes the API returns. Unknown codes are shown verbatim. */
import type { SourceFreshnessState } from "./contract.ts";

export const NOT_READ: Record<string, string> = {
  personal_local_file: "Personal file (CLAUDE.local.md). Never read, by design.",
  symlink_not_followed: "Symlink. Not followed, so its target is not audited.",
  case_variant_name: "Name differs only by letter case (for example agents.md). Some clients may load it; not read.",
  too_large: "Larger than 256 KiB. Not read.",
  hard_link: "Has more than one hard link. Not read.",
  changed_during_read: "Changed while being read. Scan again.",
  not_regular_file: "Not a regular file. Not read.",
  unreadable: "Could not be read.",
  limit_reached: "Source limit reached. Not read.",
  invalid_utf8: "Not valid UTF-8 text. Not read.",
  binary: "Looks binary. Not read.",
};

export const FRESH: Record<SourceFreshnessState, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  metadata_unchanged: { label: "Metadata unchanged", tone: "ok" },
  changed: { label: "Changed since scan", tone: "warn" },
  removed: { label: "Removed since scan", tone: "bad" },
  unsafe: { label: "Unsafe now (symlink or hard link)", tone: "bad" },
  unknown: { label: "Unknown", tone: "muted" },
};

export const CHECK_NAMES: Record<string, string> = {
  D00: "Empty file",
  D01: "SKILL.md frontmatter",
  D02: "Skill name",
  D03: "Skill description",
  D04: "Skill compatibility field",
  D07: "File length",
  D08: "Which file Claude Code reads",
  D09: "Import target",
  D10: "Repeated line",
  D12: "Secret-like text",
  D13: "Unsafe instruction",
  D14: "Invisible characters",
  D15: "Prompt injection",
  S01: "Possible contradiction",
  S02: "Possibly stale",
  S03: "Possibly vague",
  S04: "Possibly wrong scope",
  S05: "Skill description vs body",
};

export const PLATFORM_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };
