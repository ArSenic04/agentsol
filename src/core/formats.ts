import path from "node:path";

export const SOURCE_FORMATS = ["agents-md", "agents-override-md", "claude-md", "claude-local-md", "skill-md"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/** Official documentation each adapter encodes (re-verify when vendors change behavior). */
export const FORMAT_DOCS: Record<SourceFormat, string> = {
  "agents-md": "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
  "agents-override-md": "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
  "claude-md": "https://code.claude.com/docs/en/memory",
  "claude-local-md": "https://code.claude.com/docs/en/memory",
  "skill-md": "https://agentskills.io/specification",
};

export function detectFormat(relPath: string): SourceFormat | null {
  switch (path.posix.basename(relPath)) {
    case "AGENTS.md":
      return "agents-md";
    case "AGENTS.override.md":
      return "agents-override-md";
    case "CLAUDE.md":
      return "claude-md";
    case "CLAUDE.local.md":
      return "claude-local-md";
    case "SKILL.md":
      return "skill-md";
    default:
      return null;
  }
}

const dirOf = (relPath: string): string => {
  const d = path.posix.dirname(relPath);
  return d === "." ? "" : d;
};

/** The project directory whose subtree a source applies to ("" is the project root). */
export function scopeDirOf(relPath: string, format: SourceFormat): string {
  const dir = dirOf(relPath);
  if (format === "claude-md" && path.posix.basename(dir) === ".claude") return dirOf(dir);
  return dir;
}

export const fileDirOf = dirOf;

/** True when `dir` is `ancestor` itself or lies beneath it ("" is the root). */
export const isSameOrBelow = (dir: string, ancestor: string): boolean =>
  ancestor === "" || dir === ancestor || dir.startsWith(`${ancestor}/`);
