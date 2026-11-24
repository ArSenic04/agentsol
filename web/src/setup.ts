import { docHref, h, replace, route } from "./dom.ts";
import { codeBlock } from "./workspace.ts";

function stepBlock(n: number, title: string, ...body: (HTMLElement | string | null)[]): HTMLElement {
  return h("li", { class: "setup-step" }, h("h2", {}, h("span", { class: "step-n", attrs: { "aria-hidden": "true" } }, String(n)), title), ...body);
}

const NPM_PAGE = "https://www.npmjs.com/package/agentsol";
const PKG = ["-y", "-p", "agentsol@alpha", "agentsol-mcp"];
const JSON_CONFIG = [
  "{",
  "  \"mcpServers\": {",
  "    \"agentsol\": {",
  "      \"command\": \"npx\",",
  `      "args": [${PKG.map((a) => `"${a}"`).join(", ")}]`,
  "    }",
  "  }",
  "}",
];

type Client = { id: string; name: string; where: string; lines: string[]; wrap?: boolean; note?: string };

/** One entry per assistant. Every one runs the same npm package on the person's own machine. */
export const CLIENTS: readonly Client[] = [
  { id: "claude-code", name: "Claude Code", where: "Run once in any terminal:", lines: [`claude mcp add agentsol -s user -- npx ${PKG.join(" ")}`], note: "Or install the plugin, which adds the server and the Agentsol skill: claude plugin marketplace add ArSenic04/agentsol, then claude plugin install agentsol@agentsol." },
  { id: "codex", name: "Codex", where: "Run once (the Codex CLI, IDE extension and app share this config):", lines: [`codex mcp add agentsol -- npx ${PKG.join(" ")}`] },
  { id: "gemini", name: "Gemini CLI", where: "Run once in any terminal:", lines: [`gemini mcp add -s user agentsol npx ${PKG.join(" ")}`], note: "Gemini CLI loads MCP servers only in folders you trust. If agentsol shows as disabled, trust the folder when Gemini asks." },
  { id: "vscode", name: "VS Code", where: "Run once (GitHub Copilot agent mode reads it):", lines: [`code --add-mcp '{"name":"agentsol","command":"npx","args":[${PKG.map((a) => `"${a}"`).join(",")}]}'`] },
  { id: "cursor", name: "Cursor", where: "Add to ~/.cursor/mcp.json:", wrap: false, lines: JSON_CONFIG },
  { id: "claude-desktop", name: "Claude Desktop", where: "Settings → Developer → Edit Config, then add:", wrap: false, lines: JSON_CONFIG, note: "Agentsol is not in Claude's connector directory; this config is how you add it. Quit and reopen the app after saving. On Mac and Linux the app does not see your terminal's PATH, so npx from nvm, Homebrew or ~/.local/bin fails to start: run npx -y agentsol@alpha connect claude-desktop, which prints this config with the full npx path for your machine." },
  { id: "windsurf", name: "Windsurf", where: "Add to ~/.codeium/windsurf/mcp_config.json:", wrap: false, lines: JSON_CONFIG },
];

/** Accessible tabs: one panel per client, arrow keys move between tabs. */
export function installPicker(): HTMLElement {
  const tabs: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];
  const select = (i: number, focus: boolean): void => {
    tabs.forEach((t, j) => {
      t.setAttribute("aria-selected", String(i === j));
      t.setAttribute("tabindex", i === j ? "0" : "-1");
      const p = panels[j];
      if (p) p.hidden = i !== j;
    });
    if (focus) tabs[i]?.focus();
  };
  CLIENTS.forEach((c, i) => {
    tabs.push(h("button", {
      class: "tab",
      attrs: { type: "button", role: "tab", id: `tab-${c.id}`, "aria-controls": `panel-${c.id}`, "aria-selected": String(i === 0), tabindex: i === 0 ? "0" : "-1" },
      onClick: () => select(i, false),
      onKeydown: (e) => {
        const n = CLIENTS.length;
        const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
        if (next >= 0) { e.preventDefault(); select(next, true); }
      },
    }, c.name));
    panels.push(h("div", { class: "picker-body", hidden: i !== 0, attrs: { role: "tabpanel", id: `panel-${c.id}`, "aria-labelledby": `tab-${c.id}`, tabindex: "0" } },
      h("p", {}, c.where),
      codeBlock(c.lines, { label: `${c.name} setup`, wrap: c.wrap ?? true }),
      c.note ? h("p", { class: "muted small" }, c.note) : null));
  });
  return h("div", { class: "picker" },
    h("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Choose your assistant" } }, ...tabs),
    ...panels);
}

export const SKILL_MD = [
  "---",
  "name: agentsol-audit",
  "description: Reviews coding-agent work with the Agentsol MCP server - the AGENTS.md, CLAUDE.md and SKILL.md files agents follow, what agents did in recent sessions, and how the AI apps on this machine are set up. Use when the user asks to check instructions, review what an agent did, or check their AI setup.",
  "---",
  "",
  "# Audit agent instructions with Agentsol",
  "",
  "1. Call projects_list. If the project is missing, ask the user to run `npx -y agentsol@alpha start` in it. You cannot register projects yourself.",
  "2. Call sources_scan, then findings_list. Report structural findings as facts, grouped by file.",
  "3. Call source_read on the files involved. Look for instructions that conflict, are stale or too vague.",
  "4. Submit each observation with findings_submit as a POSSIBLE issue, quoting the exact lines and the current versionId.",
  "5. For fixes, call change_propose. Never edit instruction files directly.",
  "6. End by telling the user to run `npx -y agentsol@alpha review <proposalId>` in their own terminal. Only they can approve or apply.",
  "",
  "## Review what agents did",
  "",
  "1. Call sessions_list, then session_review on the risky ones. Findings A01-A14 are facts; report them as facts.",
  "2. Grade a session with session_grade on the rubric (safety, instructions, verification, efficiency, scope), citing step numbers. Grades are your judgment and are labelled that way.",
  "",
  "## Check the AI setup",
  "",
  "Call setup_audit and explain the findings, most serious first, with the exact setting to change. Never change settings yourself.",
  "",
  "## Before you start work in a project",
  "",
  "Call project_briefing with path set to the folder you work in (it can be left out when the server started in the project, as in Claude Code, Codex and Gemini CLI), and follow what it returns. It lists rules from mistakes agents already repeated there, instruction lines that are out of date with what to do instead, and commands to ask the user about first. Before a build, test, install or deploy command, call command_check and use its instead command when the verdict is change; ask the user when it is ask.",
  "",
  "## Learn from repeated mistakes",
  "",
  "1. Call lessons_list. Lead with what the mistakes cost (time and tokens lost), then each lesson with its rule and the sessions it came from.",
  "2. Show wrong instructions first: each conflict is a line in AGENTS.md or CLAUDE.md that tells agents to run the failing command, with the corrected line. For rules already written down, say why they did not help.",
  "3. Ask the user which corrections and rules to keep. For lessons with no rule, ask how that command should be run here.",
  "4. Call change_propose for suggestedChange and once for each otherChanges entry, keeping only what the user chose. Never edit AGENTS.md or CLAUDE.md directly.",
  "",
];

export function renderSetup(root: HTMLElement): void {
  const npmHref = docHref(NPM_PAGE);
  replace(root,
    h("section", { class: "page" },
      h("p", { class: "eyebrow" }, h("span", { class: "pulse", attrs: { "aria-hidden": "true" } }), "Install · about two minutes · $0"),
      h("h1", { class: "page-title", attrs: { tabindex: "-1", id: "page-title" } }, "Set it up once. ", h("span", { class: "grad" }, "Every agent session starts briefed.")),
      h("p", { class: "lede" }, "Agentsol is one npm package (",
        npmHref ? h("a", { href: npmHref, external: true }, "npmjs.com/package/agentsol") : "npmjs.com/package/agentsol",
        ", early alpha, MIT). It runs on your machine. There is no Agentsol server, account or API key."),
      h("p", { class: "note" }, h("strong", {}, "Requirements: "), "Node.js 24 or newer. Every change is tested on macOS, Linux and Windows with Node 24 and 26. Commands are for macOS and Linux shells."),
      h("ol", { class: "setup" },
        stepBlock(1, "Install, then set up your project", h("p", {}, h("code", {}, "start"), " registers the folder in ", h("code", {}, "~/.agentsol"), ", reads its instruction files, finds the AI apps on your machine and asks before connecting each one, then shows what to fix first. Home, system and broad folders are refused. When an AI agent runs it, it connects nothing."), codeBlock(["npm i -g agentsol@alpha", "cd your-project", "agentsol start"]), h("p", { class: "muted small" }, "Without installing: ", h("code", {}, "npx -y agentsol@alpha start"), ". The hooks in step 2 need the installed copy.")),
        stepBlock(2, "Brief and guard every agent session", h("p", {}, "Adds two hooks to each of Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI and Cline that is on your machine, asking per app. At session start the agent gets this project's lessons. Before each shell command, a command that failed here before is blocked, with the one that works. A backup is kept and your other hooks stay. In Cline, also turn on Enable Hooks."), codeBlock(["agentsol connect --guard", "agentsol guard --test \"npm install\"", "agentsol connect --guard --remove"]), h("p", { class: "muted small" }, "Pause with ", h("code", {}, "AGENTSOL_GUARD=off"), ". Run connect --guard again after moving or reinstalling Node.")),
        stepBlock(3, "Or connect an app by hand", h("p", {}, "For apps ", h("code", {}, "start"), " cannot connect, such as Claude Desktop and Windsurf. Pick your app and paste the lines. ", h("code", {}, "agentsol connect"), " prints the same in your terminal."), installPicker(),
          h("p", { class: "muted small" }, "Any other MCP client: command ", h("code", {}, "npx"), ", arguments ", h("code", {}, PKG.join(" ")), ". To keep data outside ", h("code", {}, "~/.agentsol"), ", set ", h("code", {}, "AGENTSOL_WORKSPACE"), " for both the CLI and the server.")),
        stepBlock(4, "Teach your agents from their mistakes", h("p", {}, h("code", {}, "learn"), " finds what repeated across your Claude Code and Codex sessions in this project over the last 180 days: commands that fail here, files agents keep breaking, things you keep telling them. It shows the time it cost and the instruction line that causes it. ", h("code", {}, "--propose"), " stores the fixes for you to review in step 7."), codeBlock(["agentsol learn", "agentsol learn --since 365d", "agentsol learn --propose"])),
        stepBlock(5, "Ask your agent", h("p", {}, "Say ", h("em", {}, "“Use agentsol to audit this project”"), " or ", h("em", {}, "“Use agentsol learn.”"), " In Claude Code these are ", h("code", {}, "/mcp__agentsol__audit"), " and ", h("code", {}, "/mcp__agentsol__learn"), ". To make it a habit, save this as ", h("code", {}, ".claude/skills/agentsol-audit/SKILL.md"), " or wherever your app reads Agent Skills."),
          codeBlock(SKILL_MD, { label: "SKILL.md for agents", wrap: true })),
        stepBlock(6, "See what agents did and what they may do", h("p", {}, h("code", {}, "sessions"), " flags risky steps in your Claude Code and Codex transcripts. ", h("code", {}, "doctor"), " checks every AI app's settings. ", h("code", {}, "inspect"), " scans a skill or MCP server before you install it. All three only read."), codeBlock(["agentsol sessions", "agentsol session <id> --timeline", "agentsol doctor", "agentsol inspect <folder>"])),
        stepBlock(7, "Review and decide, as a person", h("p", {}, "In a normal terminal, never through the agent. Approve shows the diff again and asks for a one-time code; apply keeps a backup. Agent-driven terminals are refused."), codeBlock(["review", "approve", "apply"].map((v) => `npx -y agentsol@alpha ${v} <proposalId>`))),
        stepBlock(8, "No MCP? Use any chat AI", h("p", {}, "Web chats cannot run local tools. This prints one prompt with your instruction files (secret-like text masked) and what Agentsol found; paste it into the chat you use. No terminal at all? Use the ", h("a", { href: route("#/check") }, "browser checker"), "."), codeBlock(["agentsol prompt | pbcopy"]), h("p", { class: "muted small" }, "On Linux pipe to xclip -selection clipboard, on Windows to clip.")),
        stepBlock(9, "Optional: the synthetic demo and this website, from source", h("p", {}, "The demo and the local website are not in the npm package. With a copy of the source repository:"), codeBlock(["npm ci", "npm run demo", "npm run web:build", "npm run web:local -- --workspace \"$TMPDIR/agentsol-demo/workspace\""]), h("p", {}, "Then open the address it prints and go to ", h("a", { href: route("#/workspace") }, "Workspace"), ". That server is read-only, bound to 127.0.0.1, and cannot scan, edit, approve or apply."))),
      h("p", { class: "muted small" }, "Tested so far: Claude Code ran live with the alpha.7 hooks (the briefing reached the agent and a wrong command was blocked) and earlier ran the full audit. Gemini CLI connected and listed the tools. The hook formats of Codex, Gemini CLI, Cursor, Copilot CLI and Cline are tested against each app's documented input, not yet run live. Everything else is covered by automated tests on synthetic transcripts and settings in a fake home folder.")));
}
