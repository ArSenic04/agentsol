# AgentWeave (slice 1)

AgentWeave audits AI agent instruction files (AGENTS.md, AGENTS.override.md, CLAUDE.md, CLAUDE.local.md, SKILL.md) with the assistant you already use. The assistant reads and proposes changes through MCP. Only you can approve and apply a change, from a local CLI.

Status: an early local prototype. There is no website, no hosted service and no package release.

## Requirements
Node.js 24 or later (developed on 26.8.2). Run `npm ci` inside this folder; nothing is installed globally.

## Run
```sh
npm run check                                   # typecheck plus all tests
export AGENTWEAVE_WORKSPACE="$PWD/.local-workspace"   # gitignored
npm run cli -- project add /path/to/a/project --name demo
npm run cli -- projects
npm run cli -- scan <projectId>
npm run cli -- findings <projectId>
npm run cli -- review <proposalId>
npm run cli -- approve <proposalId>   # interactive terminal; type the code shown by review
npm run cli -- apply <proposalId>     # interactive terminal; type "apply"
npm run mcp                           # MCP server on stdio, same workspace
```

Example MCP client config (stdio). Not installed automatically:
```json
{ "command": "node", "args": ["/ABSOLUTE/PATH/agentweave/src/mcp/main.ts", "--workspace", "/ABSOLUTE/PATH/agentweave/.local-workspace"] }
```

## MCP tools
`projects_list`, `sources_scan`, `sources_list`, `source_read`, `scope_resolve`, `checks_run`, `findings_list`, `findings_submit`, `change_propose`, `change_status`. There is no approve, apply, write or delete tool.

## What is protected
- Only projects you registered with the CLI are visible. Your home directory and `/` are refused.
- Symlinks are never followed. Secret-like files (`.env`, keys, credentials, `.ssh`, and similar) are never read. Secret-like values are redacted before storage and before anything goes to the assistant.
- Assistant findings are labelled "possible" and need exact quotes from the current file version.
- A change is applied only after you approve it: the approval is single-use and bound to that exact proposal and file hash. A file that changed on disk is refused, a backup is kept, and the write is atomic.

## Known limitations
- Text returned by MCP tools goes to your assistant provider. It is redacted by pattern, and patterns can miss secrets.
- Tested over a real stdio MCP process with the official SDK client. Not yet tested inside Claude Desktop or Claude Code.
- Claude Code scope assumes the default "Project instructions" setting. User-level, managed and `.claude/rules` files are not inspected. Cursor `.mdc` rules are not supported.
- Only LF or CRLF files with consistent line endings can be edited. Lines with redacted secrets cannot be edited through AgentWeave.
- Some failure modes are not covered by tests, for example power loss during rename or a concurrent writer between the final hash check and the rename (that window is very small but not zero).
- On macOS and Linux only; not tested on Windows.
