/**
 * Synthetic demo project. Kept as data (not as real files in this repo) so coding
 * agents working on Agentsol never load these files as instructions. Every value,
 * including the fake key, is invented.
 */
export const DEMO_FILES: Record<string, string> = {
  "README.md": "# Paper Lantern (synthetic demo project)\n\nNothing here is real.\n",
  "AGENTS.md": [
    "# Paper Lantern",
    "",
    "- Use npm to run scripts.",
    "- Always run the unit tests before you commit.",
    "- Demo key for the sandbox: sk-DEMOFAKEDEMOFAKEDEMOFAKE0000",
    "",
  ].join("\n"),
  "services/api/AGENTS.md": ["# API service", "", "- Use pnpm to run scripts in this package.", "- Always run the unit tests before you commit.", ""].join("\n"),
  "CLAUDE.md": ["# Claude notes", "", "@AGENTS.md", "@docs/style-guide.md", "@.env.local", ""].join("\n"),
  "CLAUDE.local.md": "# Personal notes (skipped by Agentsol by default)\n",
  "skills/Release-Notes/SKILL.md": ["---", "name: Release-Notes", "description: Drafts release notes from merged pull requests.", "---", "", "# Steps", ""].join("\n"),
  "skills/changelog/SKILL.md": ["---", "name: changelog", "---", "", "Body without a description.", ""].join("\n"),
  ".env.local": "DEMO_ONLY=not-a-real-value\n",
  "src/index.ts": "export const answer = 42;\n",
};

/** Marker that lets the demo script recognize (and only ever delete) its own folder. */
export const DEMO_MARKER = ".agentsol-demo";
/** Markers written by demos created under earlier product names (AgentWeave, Agentlore); still recognized so those demos are never treated as foreign folders. */
export const LEGACY_DEMO_MARKERS = [".agentweave-demo", ".agentlore-demo"] as const;
