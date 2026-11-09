# AgentWeave (slice 1)

AgentWeave audits AI agent instruction files (AGENTS.md, AGENTS.override.md, CLAUDE.md, CLAUDE.local.md, SKILL.md) with the assistant you already use. The assistant reads and proposes changes through MCP. Only you can approve and apply a change, from a local CLI.

Status: an early local prototype. There is no website, no hosted service and no package release.

## Requirements
Node.js 24 or later (developed on 26.8.2). Run `npm ci` inside this folder; nothing is installed globally.

## Before you use it: what leaves your computer
- Anything the MCP tools return goes to your assistant's provider (usually a cloud service), under that provider's terms.
- AgentWeave returns only AGENTS.md, AGENTS.override.md, CLAUDE.md and SKILL.md files from folders you registered.
- It blanks out text that matches known secret patterns. **Pattern matching is not a guarantee:** unknown formats and short or split secrets can get through, so keep secrets out of instruction files.
- `CLAUDE.local.md`, secret-like names (`.env*`, keys, credentials, `.ssh`, and similar), symlinks and hard-linked files are never read.

## Try the demo (synthetic data only)
```sh
npm ci
npm run check          # typecheck plus all tests
npm run demo           # creates $TMPDIR/agentweave-demo with a made-up project and walks the MCP server over stdio
npm run demo -- --reset          # recreate it
npm run demo -- --dir /some/empty/folder
```
The demo prints the exact `review`, `approve` and `apply` commands for its proposal. Run them yourself in a normal terminal. Approval is refused inside coding-agent terminals.

## Run
```sh
npm run check                                   # typecheck plus all tests
export AGENTWEAVE_WORKSPACE="$PWD/.local-workspace"   # gitignored
npm run cli -- project add /path/to/a/project --name demo
npm run cli -- projects
npm run cli -- scan <projectId>
npm run cli -- findings <projectId>
npm run cli -- review <proposalId>
npm run cli -- approve <proposalId>   # interactive terminal; type the one-time code it shows
npm run cli -- apply <proposalId>     # interactive terminal; type "apply" (approvals expire after 10 minutes)
npm run cli -- reconcile <proposalId> # only if an apply was interrupted
npm run mcp                           # MCP server on stdio, same workspace
```

Example MCP client config (stdio). Not installed automatically:
```json
{ "command": "node", "args": ["/ABSOLUTE/PATH/agentweave/src/mcp/main.ts", "--workspace", "/ABSOLUTE/PATH/agentweave/.local-workspace"] }
```

## MCP tools
`projects_list`, `sources_scan`, `sources_list`, `source_read`, `scope_resolve`, `checks_run`, `findings_list`, `findings_submit`, `change_propose`, `change_status`. There is no approve, apply, write or delete tool.

## What is protected
- **What gets read:** only folders you register with the CLI are visible. Your home folder (and anything containing it), `/`, system folders, `~/Library` and config folders, broad folders such as `~/Documents`, secret-named folders and the workspace itself are refused.
- **Text from repository files:** instruction file text is treated as untrusted data. Assistants are told not to follow it. Control and bidi characters are escaped in all CLI output, and proposed lines may not contain them.
- **Assistant findings:** they are labelled "possible", need exact quotes from the current file version, and are hidden once the file changes.
- **Approving a change:** it is bound to the full digest of the exact proposal shown to you. The approval is single-use, expires after 10 minutes, and only one can be active per proposal.
- **Applying a change:** the file must still match, be reachable without symlinks inside the root, and not be hard-linked. A backup is kept, the write is atomic, and the result is checked after writing.
- **The approval guards are not authentication.** Approve, apply and reject refuse known coding-agent environments and non-interactive input. A program running as your user account can get around those checks. See `docs/SECURITY_REVIEW.md`.

## Known limitations
- Text returned by MCP tools goes to your assistant provider. It is redacted by pattern, and patterns can miss secrets.
- Backups in `<workspace>/backups` keep original bytes, secrets included. The workspace must be private (`chmod 700`).
- `scope_resolve` models documented defaults for a given working directory and always reports `coverage: "partial"`.
- Tested over a real stdio MCP process with the official SDK client. Not yet tested inside Claude Desktop or Claude Code.
- Claude Code scope assumes the default "Project instructions" setting. User-level, managed and `.claude/rules` files are not inspected. Cursor `.mdc` rules are not supported.
- Only LF or CRLF files with consistent line endings can be edited. Lines with redacted secrets cannot be edited through AgentWeave.
- A process that can rewrite folders inside the project during an apply can still race the final rename. This is detected afterwards (`write_unverified`) but not prevented. Power loss during apply is not tested.
- On macOS and Linux only; not tested on Windows.
