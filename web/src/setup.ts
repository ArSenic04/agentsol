import { h, replace, route } from "./dom.ts";
import { codeBlock } from "./workspace.ts";

function stepBlock(n: number, title: string, ...body: (HTMLElement | string)[]): HTMLElement {
  return h("li", { class: "setup-step" }, h("h2", {}, h("span", { class: "step-n", attrs: { "aria-hidden": "true" } }, String(n)), title), ...body);
}

export function renderSetup(root: HTMLElement): void {
  replace(root,
    h("section", { class: "page" },
      h("p", { class: "eyebrow" }, "Local setup"),
      h("h1", { class: "page-title", attrs: { tabindex: "-1", id: "page-title" } }, "Run Agentlore on your machine"),
      h("p", { class: "lede" }, "Agentlore is not published yet. There is no public download or npm package. If you have a copy of the source, these are the exact steps. Everything runs locally and nothing is installed globally."),
      h("p", { class: "note" }, h("strong", {}, "Requirements: "), "Node.js with built-in TypeScript support. Only Node 26.8.2 on macOS has been tested; the declared minimum is Node 24. No paid assistant is needed for steps 1–6."),
      h("ol", { class: "setup" },
        stepBlock(1, "Install exact dependencies", h("p", {}, "From the project folder:"), codeBlock(["npm ci"])),
        stepBlock(2, "Check your setup", h("p", {}, "Reports the Node version, whether packages match the lockfile, and whether this terminal can approve changes. Read-only; no network."), codeBlock(["npm run doctor"])),
        stepBlock(3, "Create the synthetic demo", h("p", {}, "Makes a throwaway project under your temp folder and drives the MCP server over stdio. It never touches your real projects. Running it again keeps the existing demo."), codeBlock(["npm run demo"])),
        stepBlock(4, "Browse it in this website, locally", h("p", {}, "Starts a read-only server on 127.0.0.1 for that one workspace. It cannot scan, edit, approve or apply."), codeBlock(["npm run web:build", "npm run web:local -- --workspace \"$TMPDIR/agentlore-demo/workspace\""]), h("p", {}, "Then open the address it prints and go to ", h("a", { href: route("#/workspace") }, "Workspace"), ".")),
        stepBlock(5, "Review and decide, as a person", h("p", {}, "In a normal terminal. Approve shows the diff again and asks for a one-time code; apply keeps a backup."), codeBlock(["npm run cli -- --workspace \"$TMPDIR/agentlore-demo/workspace\" review <proposalId>", "npm run cli -- --workspace \"$TMPDIR/agentlore-demo/workspace\" approve <proposalId>", "npm run cli -- --workspace \"$TMPDIR/agentlore-demo/workspace\" apply <proposalId>"])),
        stepBlock(6, "Use it on your own project", h("p", {}, "Pick a private workspace folder and register a project folder explicitly. Home, system and broad folders are refused."), codeBlock(["export AGENTLORE_WORKSPACE=\"$PWD/.local-workspace\"", "npm run cli -- project add /path/to/your/project", "npm run cli -- scan <projectId>", "npm run cli -- status"])),
        stepBlock(7, "Optional: connect an assistant yourself", h("p", {}, "Agentlore is an MCP server over stdio. ", h("code", {}, "npm run doctor -- --workspace <dir>"), " prints a config with absolute paths, shaped like this. Agentlore never installs it for you, and no specific assistant app has been validated yet."),
          codeBlock(["{", "  \"command\": \"/absolute/path/to/node\",", "  \"args\": [", "    \"/absolute/path/to/your-checkout/src/mcp/main.ts\",", "    \"--workspace\",", "    \"/absolute/path/to/workspace\"", "  ]", "}"], { label: "Example MCP config", wrap: false }))),
      h("p", { class: "muted small" }, "Protocol tests use the official MCP TypeScript SDK client over a real stdio process. That is not the same as validation in an assistant app.")));
}
