# AgentWeave: instructions for agents working in this repo

## Hard rules
- Local only. No deployment, no pushes, no public uploads, no paid APIs or services. Budget for new spending is $0.
- Do not read or audit real company or personal project files. Tests and demos use synthetic fixtures in temp directories only.
- Never put secrets in code, fixtures, logs or commits. Fixture "secrets" must be obvious fakes (for example `sk-FAKE...`).
- Do not install packages globally or change global config. Dependencies are pinned exactly in `package.json`, and `.npmrc` sets `ignore-scripts=true`.
- Do not overwrite files you did not create. Prefer adding files to rewriting them.

## Product guardrails (do not weaken without the owner's explicit approval)
- MCP tools may read, audit, record findings and store proposals. They must never approve, apply, delete or write project files.
- `src/mcp/**` must never import `src/core/humanApproval.ts` (a test enforces this).
- Approval and apply are human-only CLI commands. They need an interactive terminal and a typed confirmation code.
- An approval is bound to one exact proposal digest and base file hash, and it can be used once.
- An apply re-checks the on-disk hash, refuses symlinks and paths outside the project, writes a backup inside the workspace, and replaces the file atomically.
- Assistant-reported findings are always labelled "possible" and need exact quoted evidence from the current version.
- Overlapping or nested instruction scopes count as layered context, not conflicts.

## Commands
- `npm run typecheck`
- `npm test` (Node's test runner, including real stdio MCP process tests)
- `npm run check` runs both.
