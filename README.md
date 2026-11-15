# Agentsol (early local prototype)

_Earlier names: AgentWeave, then Agentlore (both Nov 2026; the npm name `agentlore` was refused as too similar to an existing package). Older workspaces, demos and the `AGENTLORE_WORKSPACE` / `AGENTWEAVE_WORKSPACE` variables keep working; see "Earlier names" below. Published on npm as `agentsol` (tags `alpha` and `latest`); this checkout is `0.2.0-alpha.2`._

Agentsol is an agent that reviews agent work, with the assistant you already use:

- **Instructions.** It audits AI agent instruction files (AGENTS.md, AGENTS.override.md, CLAUDE.md, .claude/CLAUDE.md, SKILL.md), including rules that tell assistants to do something unsafe (curl | sh, --no-verify, force-push, skipping failing tests, printing secrets), prompt-injection phrasing and invisible characters (D13–D15). The assistant reads and proposes changes through MCP. Only you can approve and apply a change, from a local CLI.
- **Sessions.** `agentsol sessions` reads the Claude Code and Codex transcripts on your machine and flags what the agents did: destructive commands, secrets exposed to the model, skipped hooks, weakened tests, edits never verified, retry loops, prompt injection in tool output, insecure code the agent added such as SQL injection, disabled TLS checks or eval (14 checks, A01–A14). Your assistant can then grade a session on a five-part rubric (safety, instructions, verification, efficiency, scope); grades are stored as assistant judgment next to the deterministic findings, never instead of them.
- **Setup.** `agentsol doctor` checks your AI apps' settings (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Gemini CLI): plaintext secrets in MCP config, unpinned or missing MCP servers, shell-wrapped launches, settings that let assistants act without asking, hooks, and how many tokens your global instructions add to every session (10 checks, C01–C10).

> **Alpha (0.2.0-alpha.2). Read this first.**
> - **A person has not yet run approve and apply end to end through this CLI.** Those steps are covered by automated core tests only. Try them on the synthetic demo before any real project, and keep your files in version control.
> - **No real assistant app has been validated.** Claude Code, Codex, Cursor and others are untested. Only the official MCP TypeScript SDK client has been used, in automated tests.
> - Tested only on macOS (arm64) with Node 24.0.0, 24.22.2 and 26.8.2. There is no hosted service. Passing tests do not make it production-ready.

Licence: MIT (see `LICENSE`).

## Requirements
- **Installed package:** Node 24 or later. The installed package (compiled JavaScript) passed its install check on Node 24.0.0, 24.22.2 and 26.8.2 on macOS arm64. Windows and Linux are untested.
- **From source (this folder):** Node with built-in TypeScript support. The source checkout and its test suite have only been run on Node 26.8.2. Run `npm ci` inside this folder; nothing is installed globally. `npm run doctor` checks this for you.

## Before you use it: what leaves your computer
- Anything the MCP tools return goes to your assistant's provider (usually a cloud service), under that provider's terms.
- Agentsol returns only AGENTS.md, AGENTS.override.md, CLAUDE.md and SKILL.md files from folders you registered.
- It blanks out text that matches known secret patterns. **Pattern matching is not a guarantee:** unknown formats and short or split secrets can get through, so keep secrets out of instruction files.
- Session and setup review returns derived facts only: check ids, step kinds, masked commands and paths, and setting names. Transcript text, tool output and secret values are never returned. Over MCP, sessions are limited to folders you registered, and absolute paths are replaced with `<project>`, `~` or `<path>`. The CLI shows you every session on your machine.
- `CLAUDE.local.md`, secret-like names (`.env*`, keys, credentials, `.ssh`, and similar), symlinks and hard-linked files are never read.

## First-run walkthrough (synthetic data only)
Run every step from this folder, in your own terminal.

1. **Install from the lockfile.** `npm ci` (exact versions from `package-lock.json`; nothing global).
2. **Preflight.** `npm run doctor`. It reports the Node version, whether the installed packages match the lockfile, whether this terminal is agent-driven (approve/apply refuse there), and with `-- --workspace <dir>` whether that folder is private. It reads only; it never creates or upgrades a workspace, uses the network, or configures any app. `--json` for machine-readable output.
3. **Tests.** `npm run check` (typecheck plus all tests; fixtures are synthetic temp folders).
4. **Synthetic demo.** `npm run demo`. It creates `$TMPDIR/agentsol-demo` with a made-up project, drives the MCP server over stdio with the official SDK client (scan, read, a "possible" finding, one proposed edit), and prints the commands for the next steps. Nothing in the project is changed.
   - Running `npm run demo` again keeps the demo and prints its pending proposals and next commands.
   - `npm run demo -- --reset` recreates it, but refuses while the demo holds proposals; add `--discard-proposals` to delete them on purpose.
   - `npm run demo -- --dir /some/empty/folder` puts it elsewhere.
5. **Check the workspace.** `npm run cli -- --workspace "$TMPDIR/agentsol-demo/workspace" status`. It shows the last-scan snapshot, partial coverage, and whether files changed on disk since the scan.
6. **Review and decide, as a person.**
   - `npm run cli -- --workspace <ws> review <proposalId>`
   - `npm run cli -- --workspace <ws> approve <proposalId>`: shows the diff again and asks you to type a one-time code.
   - `npm run cli -- --workspace <ws> apply <proposalId>`: writes the demo file and keeps a backup.

   Approve, reject and apply refuse to run inside coding-agent terminals or without an interactive terminal.
7. **Optional: connect a client yourself.** `npm run doctor -- --workspace <ws>` prints an MCP stdio config with absolute paths (example below). Agentsol never installs it, and no paid assistant is needed for steps 1–6.

**What has and has not been validated.** The tests and the demo are *protocol smoke tests*: they use the official MCP TypeScript SDK client over a real stdio process. No real assistant client (Claude Code, Claude Desktop, Codex, Cursor) has been validated yet, and the interactive approve/apply flow has only been exercised through core unit tests, not by a person through the CLI after the latest changes.

## Quick start from npm
Nothing is installed globally and there is no account or API key. Agentsol runs on your machine and uses the AI you already have.

```sh
cd your-project
npx -y agentsol@alpha start            # one command: registers and scans this folder, connects the AI apps you have
                                       # (asks first; --yes skips asking), shows past-session costs and what to fix first
npx -y agentsol@alpha check            # the scan alone: every finding with its line
npx -y agentsol@alpha connect          # setup lines for Claude Code, Codex, Gemini CLI, VS Code, Cursor, Claude Desktop, Windsurf
npx -y agentsol@alpha prompt | pbcopy  # no MCP? one masked prompt to paste into any chat AI
npx -y agentsol@alpha sessions         # what your AI agents did this week, risky steps flagged
npx -y agentsol@alpha session <id>     # one session: findings, metrics, grades; --timeline for every step
npx -y agentsol@alpha doctor           # preflight plus an audit of your AI apps' settings
```

- In your assistant, `/review` grades recent sessions with the rubric and `/setup` explains the setup audit. Both only read and record; neither changes files or settings.
- `sessions --since 24h|7d|2w|<date> --limit N [path]` narrows the list; `--json` everywhere. `doctor --strict` exits 1 when the setup audit finds an error.

- `check` opens an interactive report: a banner, findings sorted by severity with the cited lines, and the next steps. `--strict` exits 1 when there are errors (for CI); `--json` prints machine-readable output. Colors follow `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`; pipes get plain text. Text from your files is sanitized, so it cannot inject terminal escape codes.
- `npx -y agentsol@alpha` with no command, in a terminal, shows the home screen: workspace, the folder you are in, the tools, prompts and checks.
- The workspace defaults to `~/.agentsol` (created private, `0700`). Use `--workspace <dir>` or `AGENTSOL_WORKSPACE` to keep it elsewhere; set the same value for the CLI and the MCP server.
- The MCP server is `npx -y -p agentsol@alpha agentsol-mcp`. Your assistant cannot register folders; it tells you to run `check` when `projects_list` is empty.
- The package has no install scripts. It ships compiled JavaScript, this README and `LICENSE`, and depends on `@modelcontextprotocol/server`, `yaml` and `zod`.
- `agentsol@0.1.0-alpha.1` (Nov 9, 2026) predates `check`, `connect`, `prompt`, the default workspace and the MCP prompts. They arrive with `0.1.0-alpha.2`. Session review, grading and the setup audit arrive with `0.2.0-alpha.0`; learn arrives with `0.2.0-alpha.1`; `start` arrives with `0.2.0-alpha.2`.

## Release checks (maintainers)
- `npm run pack:check`: preview tarball in `artifacts/pack/`. It uses a strict file allowlist, fails on install-time scripts, private paths, secret-like tokens or leftover `.ts` imports, and requires `"private": true`.
- `npm run install:check -- [--tarball <file>] [--node <path>]`: clean install into a temp folder with scripts disabled, then the CLI and an MCP stdio handshake against the installed copy only.
- `npm run release:check -- --node <node24>`:
  - Packs a staged copy without `"private"` into `artifacts/release/`, and never overwrites an existing release file.
  - Runs the install check once per Node runtime, then `npm publish --dry-run` on that exact file.
  - Confirms the file's sha512 did not change.
  - Records everything in `<tarball>.release.json`.
- The repository's own `package.json` stays `"private": true`, so `npm publish` from this folder fails by design.
- Publishing is a person's step, with npm 2FA, from a normal terminal: `npm publish ./artifacts/release/agentsol-<version>.tgz --tag alpha --access public` (npm requires the `./` prefix for a relative tarball path).

## Run
```sh
npm run check                                   # typecheck plus all tests
export AGENTSOL_WORKSPACE="$PWD/.local-workspace"   # gitignored
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
{ "command": "/ABSOLUTE/PATH/TO/node", "args": ["/ABSOLUTE/PATH/TO/your-checkout/src/mcp/main.ts", "--workspace", "/ABSOLUTE/PATH/TO/your-checkout/.local-workspace"] }
```

## Website and read-only workspace view

The product site and the workspace view are one static app in `web/` (no framework, no runtime dependencies), built into `dist/web/`.

```
npm run web:build                                   # builds dist/web and records the synthetic demo data
npm run web:preview                                 # static site + demo at http://127.0.0.1:4318/ (no API)
npm run web:dev                                     # build, then preview
npm run web:local -- --workspace "<workspace dir>"  # adds your workspace, read-only, at http://127.0.0.1:4317/
npm run test:web                                    # build, then browser tests (needs the local Playwright Chromium)
```

- **Demo** (`#/demo`) shows real Agentsol output recorded from the synthetic demo project when you build. The "possible" finding and the proposed change were prewritten by the demo script. No AI wrote them.
- **Workspace** (`#/workspace`) works only under `web:local`. That bridge binds to 127.0.0.1 only and serves GET requests from the existing shared service. It cannot scan, edit, approve, apply or register folders. Approval stays in your terminal: the page shows the CLI commands to run.
- `web:local` opens only the workspace folder you name, and it must already contain `workspace.sqlite`. It never browses your home folder or projects. There is no `--host` option.
- The site loads nothing from other servers: no analytics, cookies, external fonts, CDNs or third-party scripts. A strict Content Security Policy blocks inline scripts.
- The build ships `js/mode.js` saying "static", so a static copy never calls `/api` and simply shows the "no local workspace connected" state. Only `web:local` (with a workspace) serves a "local-bridge" `mode.js`, and the page still verifies `/api/health` before showing data.
- Long source and diff lines keep their layout and scroll sideways. Those blocks are keyboard-focusable and show a hint when they overflow. Shell commands soft-wrap without changing the copied text.
- `dist/web` can be served by any static host later, after review. The local bridge (`src/web/`) must never be exposed to a network or run on a shared machine.

## Inspect a skill or MCP server before you install it
Skills and MCP servers run with your assistant's access to your files, keys and terminal. `inspect` reads one and gives a verdict (danger, caution, clean) with every finding's file and line: credential theft (SSH, cloud, npm, browser passwords), data sent to a server, secrets hidden in DNS lookups, decoded-and-run code, self-installing persistence (shell startup, cron, launch agents, git hooks), rewriting AI app settings, hidden or injected instructions and, for MCP tool lists, tool poisoning and shadowing.

```sh
npx -y agentsol@alpha inspect ./some-skill          # a skill or server folder
npx -y agentsol@alpha inspect tools.json --json     # a server's tools/list result
```

It exits 1 on danger, so it works as a CI gate. The same engine runs as the `inspect` MCP tool (files passed inline, nothing read from disk) and on the website's Inspect page, entirely in the browser. It reads text only and runs nothing; it cannot see code a server downloads at run time. On 91 public skills from three plugin marketplaces it reported no false danger.

## Learn from your agents' mistakes
Agents forget between sessions, so they repeat the same mistakes in the same project. `learn` reads the Claude Code and Codex transcripts on your machine for sessions started in this folder and finds four kinds of lesson:

- **command**: a command that fails here and the one that works (`npm test` fails, `pnpm test` works).
- **you said**: something you told agents in two or more sessions, quoted masked and shortened.
- **fragile**: a file agents edit, break and re-edit before a check passes, with the check that finally passed.
- **failing**: a command that failed in several sessions and never worked anywhere; it asks you how to run it.

It also checks your instruction files against what happened. If AGENTS.md says "run `npm test`" and `npm` fails here, that line is why agents keep doing it: `learn` shows the file and line, the corrected line, and fixes it in place instead of adding a contradicting rule. It checks every AGENTS.md, AGENTS.override.md, CLAUDE.md and CLAUDE.local.md at any depth (in a monorepo, the wrong line in `packages/web/AGENTS.md` is corrected there, not with a second rule at the root), skips lines that already warn against the command, and only treats a bare word like `pytest` as a command in code or after "run". The same goes for things you told agents more than once: if you said "never edit the generated files in gen/, run pnpm codegen" in two sessions and AGENTS.md says "Edit the generated files in gen/ when the API changes", that line is replaced with what you said, instead of counting as already covered. This works for "never X", "don't X" and "use Y instead of X" or "Y, not X"; it leaves prose that only mentions X alone, and a line about a different scope ("in unit tests" against "in integration tests"). When a rule is written down but agents still break it, it says why: Codex reads AGENTS.md and not CLAUDE.md (and when a non-empty AGENTS.override.md sits next to AGENTS.md, Codex reads only the override, so rules go there), and Claude Code reads AGENTS.md only through an `@AGENTS.md` line in CLAUDE.md. With no instruction file yet, it names the one your apps read; when only Claude Code made the mistakes and CLAUDE.md does not import AGENTS.md, new rules go to CLAUDE.md. It works with symlinked project folders, Windows commands (`npm.cmd`, `$env:CI=1`) and CRLF instruction files, older and newer Codex transcript formats, and transcripts up to 512 MB.

```bash
npx -y agentsol@alpha learn                 # last 30 days
npx -y agentsol@alpha learn --since 90d
npx -y agentsol@alpha learn --propose       # one proposal per instruction file: corrections and new rules
npx agentsol review <proposalId>
```

Each lesson cites its session ids and step numbers, says whether the instruction file already covers it, and shows the active time and tokens it cost (pauses over 5 minutes count as 5 minutes). `--propose` never writes a file: you review, approve and apply each diff yourself, and running it again returns the proposals already waiting instead of new copies. Over MCP the same report is `lessons_list`, and `/learn` walks your assistant through it. Lessons are patterns, not proof; read each rule before keeping it.

## MCP tools
`projects_list`, `workspace_status`, `sources_freshness`, `sources_scan`, `sources_list`, `source_read`, `scope_resolve`, `checks_run`, `findings_list`, `findings_submit`, `change_propose`, `changes_list`, `change_status`, `sessions_list`, `session_review`, `session_grade`, `setup_audit`, `inspect`, `lessons_list`. There is no approve, apply, write or delete tool.

Prompts: `audit` and `fix` (optional `project`), `explain` (`path`, optional `project`), `review`, `setup` and `learn` (optional `project`, `since`). They show up as `/audit`, `/fix`, `/explain`, `/review`, `/setup` and `/learn` in clients that support MCP prompts. Resource: `agentsol://guide` (markdown: the workflow, the check catalogue and how to report).

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

## Earlier names (AgentWeave, Agentlore)
- The command names are now `agentsol` and `agentsol-mcp`, the MCP server reports itself as `agentsol`, and the workspace variable is `AGENTSOL_WORKSPACE`.
- `AGENTLORE_WORKSPACE`, then `AGENTWEAVE_WORKSPACE`, still work when `AGENTSOL_WORKSPACE` is not set.
- Existing workspaces need no migration: the database format did not change.
- `npm run demo` now uses `$TMPDIR/agentsol-demo`. Demos made earlier (in `$TMPDIR/agentweave-demo` or `$TMPDIR/agentlore-demo`) are left as they were and still work with `--workspace "$TMPDIR/agentweave-demo/workspace"` or `npm run demo -- --dir "$TMPDIR/agentweave-demo"`.
- The source folder moved from `~/Projects/agentweave` to `~/Projects/agentsol`. An MCP client set up by hand with the old folder path needs that path updated.

## Known limitations
- If a different folder appears at a registered path (deleted and recreated, or swapped), scans and apply refuse with `root_replaced` until you confirm it yourself with `project add <the same path>`.
- Load figures from `npm run load:test` (synthetic monorepos up to about 5,000 files) describe one Mac and are not a guarantee; see `docs/ALPHA_VERIFICATION.md`.

- The website is an early local prototype. It has not been tested with a screen reader, has had no formal accessibility audit and has not been reviewed for public hosting. The static demo has not been published anywhere.
- Text returned by MCP tools goes to your assistant provider. It is redacted by pattern, and patterns can miss secrets.
- Backups in `<workspace>/backups` keep original bytes, secrets included. The workspace must be private (`chmod 700`).
- `scope_resolve` models documented defaults for a given working directory and always reports `coverage: "partial"`.
- Tested over a real stdio MCP process with the official SDK client (protocol smoke test). Not yet validated inside any real assistant client.
- Freshness is metadata-only and only covers files recorded by the last scan; it cannot prove that nothing changed.
- Claude Code scope assumes the default "Project instructions" setting. User-level, managed and `.claude/rules` files are not inspected. Cursor `.mdc` rules are not supported.
- Only LF or CRLF files with consistent line endings can be edited. Lines with redacted secrets cannot be edited through Agentsol.
- A process that can rewrite folders inside the project during an apply can still race the final rename. This is detected afterwards (`write_unverified`) but not prevented. Power loss during apply is not tested.
- On macOS and Linux only; not tested on Windows.
