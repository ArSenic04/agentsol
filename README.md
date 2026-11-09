# AgentWeave (early local prototype)

AgentWeave audits AI agent instruction files (AGENTS.md, AGENTS.override.md, CLAUDE.md, .claude/CLAUDE.md, SKILL.md) with the assistant you already use. The assistant reads and proposes changes through MCP. Only you can approve and apply a change, from a local CLI.

Status: an early local prototype. There is no website, no hosted service and no package release. Passing tests do not make it production-ready.

## Requirements
Node.js with built-in TypeScript support. `package.json` declares Node 24 or later, but only **Node 26.8.2 on macOS** has been tested. Run `npm ci` inside this folder; nothing is installed globally. `npm run doctor` checks this for you.

## Before you use it: what leaves your computer
- Anything the MCP tools return goes to your assistant's provider (usually a cloud service), under that provider's terms.
- AgentWeave returns only AGENTS.md, AGENTS.override.md, CLAUDE.md and SKILL.md files from folders you registered.
- It blanks out text that matches known secret patterns. **Pattern matching is not a guarantee:** unknown formats and short or split secrets can get through, so keep secrets out of instruction files.
- `CLAUDE.local.md`, secret-like names (`.env*`, keys, credentials, `.ssh`, and similar), symlinks and hard-linked files are never read.

## First-run walkthrough (synthetic data only)
Run every step from this folder, in your own terminal.

1. **Install from the lockfile.** `npm ci` (exact versions from `package-lock.json`; nothing global).
2. **Preflight.** `npm run doctor`. It reports the Node version, whether the installed packages match the lockfile, whether this terminal is agent-driven (approve/apply refuse there), and with `-- --workspace <dir>` whether that folder is private. It reads only; it never creates or upgrades a workspace, uses the network, or configures any app. `--json` for machine-readable output.
3. **Tests.** `npm run check` (typecheck plus all tests; fixtures are synthetic temp folders).
4. **Synthetic demo.** `npm run demo`. It creates `$TMPDIR/agentweave-demo` with a made-up project, drives the MCP server over stdio with the official SDK client (scan, read, a "possible" finding, one proposed edit), and prints the commands for the next steps. Nothing in the project is changed.
   - Running `npm run demo` again keeps the demo and prints its pending proposals and next commands.
   - `npm run demo -- --reset` recreates it, but refuses while the demo holds proposals; add `--discard-proposals` to delete them on purpose.
   - `npm run demo -- --dir /some/empty/folder` puts it elsewhere.
5. **Check the workspace.** `npm run cli -- --workspace "$TMPDIR/agentweave-demo/workspace" status`. It shows the last-scan snapshot, partial coverage, and whether files changed on disk since the scan.
6. **Review and decide, as a person.**
   - `npm run cli -- --workspace <ws> review <proposalId>`
   - `npm run cli -- --workspace <ws> approve <proposalId>`: shows the diff again and asks you to type a one-time code.
   - `npm run cli -- --workspace <ws> apply <proposalId>`: writes the demo file and keeps a backup.

   Approve, reject and apply refuse to run inside coding-agent terminals or without an interactive terminal.
7. **Optional: connect a client yourself.** `npm run doctor -- --workspace <ws>` prints an MCP stdio config with absolute paths (example below). AgentWeave never installs it, and no paid assistant is needed for steps 1–6.

**What has and has not been validated.** The tests and the demo are *protocol smoke tests*: they use the official MCP TypeScript SDK client over a real stdio process. No real assistant client (Claude Code, Claude Desktop, Codex, Cursor) has been validated yet, and the interactive approve/apply flow has only been exercised through core unit tests, not by a person through the CLI after the latest changes.

## Run
```sh
npm run check                                   # typecheck plus all tests
export AGENTWEAVE_WORKSPACE="$PWD/.local-workspace"   # gitignored
npm run cli -- project add /path/to/a/project --name demo
npm run cli -- projects
npm run cli -- status                # add --json for machine-readable output (also: sources, findings, scan, freshness)
npm run cli -- freshness <projectId>  # per file: changed / removed / unsafe / metadata_unchanged since the last scan
npm run doctor                        # non-destructive preflight
npm run cli -- scan <projectId>
npm run cli -- findings <projectId>
npm run cli -- review <proposalId>
npm run cli -- approve <proposalId>   # interactive terminal; type the one-time code it shows
npm run cli -- apply <proposalId>     # interactive terminal; type "apply" (approvals expire after 10 minutes)
npm run cli -- reconcile <proposalId> # only if an apply was interrupted
npm run mcp                           # MCP server on stdio, same workspace
```

Example MCP client config (stdio). Not installed automatically. GUI clients often have a different `PATH`, so use the absolute `node` path that `npm run doctor -- --workspace <dir>` prints:
```json
{ "command": "/ABSOLUTE/PATH/TO/node", "args": ["/ABSOLUTE/PATH/agentweave/src/mcp/main.ts", "--workspace", "/ABSOLUTE/PATH/agentweave/.local-workspace"] }
```

## MCP tools
`projects_list`, `sources_scan`, `sources_list`, `source_read`, `scope_resolve`, `checks_run`, `findings_list`, `findings_submit`, `change_propose`, `change_status`, `workspace_status`, `sources_freshness`. There is no approve, apply, write or delete tool.

The CLI and the MCP server call the same assistant-safe service (`src/core/service/assistant.ts`), so validation, redaction and error messages are identical; `--json` output equals the MCP result. Approve, reject, apply and project registration live in a separate operator service that only the CLI imports. `findings_submit` and `change_propose` accept an optional `requestKey`: retrying with the same key returns the original result, and reusing a key for a different request is refused.

## Status and freshness
`status` / `workspace_status` keep three things separate:
- **Last-scan snapshot:** sources, findings (`findings.basis: "last_scan_snapshot"`) and proposal counts.
- **Coverage (`scan.partial`):** what the last scan could not inspect (skipped folders, depth limit, symlinks, case variants, secret-like names, files not read).
- **Freshness (observed now):** for each file the last scan recorded, a metadata-only `lstat` comparison (size, modification and change time, inode, device, link count). No content is read.
  - Per-file states are `metadata_unchanged`, `changed`, `removed`, `unsafe` (now a symlink, not a regular file, extra hard links, or outside the root) and `unknown`.
  - Project states are:
    - `no_known_changes`, `changes_detected` or `incomplete`;
    - `unknown`, when the root is missing, a symlink or replaced, or the scan predates freshness metadata;
    - `not_checked`, when the project was never scanned.

Matching metadata does **not** prove a file is unchanged, and new files are not detected until you scan again. Evidence checks and apply never use metadata; they compare byte hashes.

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
- Tested over a real stdio MCP process with the official SDK client (protocol smoke test). Not yet validated inside any real assistant client.
- Freshness is metadata-only and only covers files recorded by the last scan; it cannot prove that nothing changed.
- Claude Code scope assumes the default "Project instructions" setting. User-level, managed and `.claude/rules` files are not inspected. Cursor `.mdc` rules are not supported.
- Only LF or CRLF files with consistent line endings can be edited. Lines with redacted secrets cannot be edited through AgentWeave.
- A process that can rewrite folders inside the project during an apply can still race the final rename. This is detected afterwards (`write_unverified`) but not prevented. Power loss during apply is not tested.
- On macOS and Linux only; not tested on Windows.
