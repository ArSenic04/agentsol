/**
 * Environment markers that coding agents set on commands they run (checked Nov 2026
 * against vendor docs and harness notes). These are labels, not proof: a process can
 * remove them. They stop an agent from approving or applying by accident or because a
 * prompt-injected instruction file told it to. They are not authentication.
 */
const MARKERS: readonly { name: string; matches: (v: string) => boolean; agent: string }[] = [
  { name: "CLAUDE_CODE_CHILD_SESSION", matches: (v) => v !== "", agent: "Claude Code" },
  { name: "CLAUDE_CODE_IS_COWORK", matches: (v) => v !== "", agent: "Claude Cowork" },
  { name: "CODEX_CI", matches: (v) => v !== "", agent: "Codex" },
  { name: "CODEX_THREAD_ID", matches: (v) => v !== "", agent: "Codex" },
  { name: "CODEX_SANDBOX", matches: (v) => v !== "", agent: "Codex" },
  { name: "CURSOR_AGENT", matches: (v) => v !== "", agent: "Cursor" },
  { name: "CURSOR_EXTENSION_HOST_ROLE", matches: (v) => v === "agent-exec", agent: "Cursor" },
  { name: "GEMINI_CLI", matches: (v) => v !== "", agent: "Gemini CLI" },
  { name: "OPENCODE", matches: (v) => v !== "", agent: "OpenCode" },
  { name: "AUGMENT_AGENT", matches: (v) => v !== "", agent: "Augment" },
  { name: "PI_CODING_AGENT", matches: (v) => v !== "", agent: "pi" },
  { name: "COPILOT_CLI", matches: (v) => v !== "", agent: "GitHub Copilot CLI" },
  { name: "COPILOT_AGENT_SESSION_ID", matches: (v) => v !== "", agent: "GitHub Copilot" },
  { name: "AI_AGENT", matches: (v) => !["", "0", "false", "no", "off"].includes(v.toLowerCase()), agent: "an AI agent" },
];

/** Returns the detected agent and variable, or null when none is present. */
export function detectAgentEnvironment(env: NodeJS.ProcessEnv): { agent: string; variable: string } | null {
  for (const m of MARKERS) {
    const v = env[m.name];
    if (v !== undefined && m.matches(v)) return { agent: m.agent, variable: m.name };
  }
  return null;
}
