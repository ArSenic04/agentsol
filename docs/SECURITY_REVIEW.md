# Adversarial review: slice 1 (Nov 9, 2026)

> **Current name: Agentsol** (renamed Nov 9, 2026, after npm refused `agentlore` as too similar to `agent-lore`). Sections below keep the names that were current when they were written (AgentWeave, Agentlore).

Scope: the code and tests in this repository. Every fixed defect has a regression test, in `tests/review-regressions.test.ts` (R1–R8), `tests/safety-v2.test.ts` or `tests/cli.test.ts`.

## Trust model
- **The MCP tool surface is the security boundary.** Tools can read, audit, record findings and store proposals. No tool approves, applies, rejects, writes, or deletes.
- **The OS user account is trusted.** Any process running as the same user can read the workspace and drive the CLI. That includes a coding agent with shell access, which can use a pseudo-terminal to look interactive.
  - The CLI refuses approve, apply and reject when it sees known agent environment markers, and they require an interactive terminal plus a one-time typed code.
  - These guards stop accidents and prompt injection. They are not authentication.
- **Instruction file text is untrusted data.** It is never executed or obeyed. Every place it is printed escapes control and bidi characters.

## Defects found and fixed
| # | Defect | Fix |
|---|---|---|
| R1 | PGP `PRIVATE KEY BLOCK` armor was not redacted | Key-block pattern covers it |
| R2 | URL credentials, Bearer/Basic, JWT, Stripe, GitLab, npm, Hugging Face and Google OAuth tokens, and short `password:` values were not redacted | Patterns added; plain prose is still left alone |
| R3 | `sources_list` disclosed names of secret-like and unrelated files (for example `acme-merger-secret-plan.md`, `.env.production`) | Only instruction-file names are ever recorded; everything else is counted |
| R4 | `CLAUDE.local.md` (personal, usually gitignored) was read and sent to the assistant | Not read by default; listed as `personal_local_file` |
| R5 | A hard link inside the project could expose a file from outside it | Files with more than one link are refused |
| R6 | A registered root replaced by a symlink was followed at scan time | The root is re-verified (not a symlink, same realpath) on every scan and apply |
| R7 | CLAUDE.md `@imports` let file content probe whether secret-like files exist | Secret-like import targets are not checked |
| R8 | Assistant-written titles, messages and rationales could store secrets | Rejected when they match secret patterns |
| — | Discovery could read through a parent directory swapped for a symlink between `readdir` and `open` | After open, the handle's (dev, ino) must equal a fresh symlink-free walk |
| — | Approval checks ran outside the transaction, so two processes could both approve | Checks run inside `BEGIN IMMEDIATE`, and a partial unique index allows one active approval |
| — | Approvals never expired | 10-minute TTL; expired approvals are voided |
| — | A crash during apply left the proposal stuck in `applying` forever | An apply intent with the expected hash is recorded; `reconcile` resolves it without writing |
| — | The approval was bound to a digest prefix the assistant could compute when the file had no secrets | Bound to the full digest of the exact proposal rendered to the person, plus a random one-time code typed back |
| — | Rationale and file text with ANSI/OSC escapes or bidi overrides could rewrite or hide the review screen | All CLI output is sanitized; replacement lines with control or bidi characters are rejected |
| — | Findings citing old versions stayed listed as current | Hidden by default and counted in `staleHidden` |
| — | `scope_resolve` modeled each target file's directory as the session start, which over-claimed what Codex loads | Explicit `workingDirectory`; launch and on-demand files reported separately; always `coverage: "partial"`, with assumptions and what was not inspected |
| — | A world-readable or symlinked existing workspace was accepted | Refused; the database file is set to 0600 |
| — | Registering `~/Documents`, `~/Library/...`, `~/.config/...`, `/etc`, secret-named folders or folders inside the workspace was allowed | Refused by `validateProjectRoot` |

## Unresolved risks (documented, not fixed)
1. **Redaction is pattern-based.** Unknown token formats, secrets split across lines, or short values will reach the assistant's provider. The mitigation is disclosure in the README, the tool descriptions, the server instructions, and D12.
2. **An agent with shell access can impersonate a person.** It only has to unset the environment markers and drive a pseudo-terminal. Closing this needs an OS-level prompt (for example Touch ID or a password dialog) or a separate user account. That is future work.
3. **There is a filesystem race window.** Node has no `openat`, `renameat` or `O_BENEATH`. A concurrent process that can rewrite directories inside the project can still swap a parent directory between the final check and `rename`. The post-rename check detects this and reports `write_unverified`, but the write has already landed.
4. **Backups hold the raw original bytes,** secrets included, in `<workspace>/backups` (directory 0700, files 0600). They are never served over MCP.
5. **The workspace database holds redacted text** that any same-user process can read.
6. **Scope modeling follows vendor documentation,** not observed client behavior. User-level, managed, `.claude/rules`, `.cursor/rules` and `@import` expansion are out of scope.
7. **A real MCP client (Claude Desktop or Claude Code) is still untested.** Only the official SDK client over stdio has been exercised.
8. **Power loss** between rename and directory fsync is not tested.

## Milestone 3 review: shared service (Nov 9, 2026)
- **One validation path.** CLI and MCP both call `createAssistantService`; a test asserts `agentlore sources|findings|status --json` equals the MCP tool result byte-for-byte as parsed JSON, including error objects.
- **Approval stays out of reach.** An import-graph walk (static and dynamic relative imports) from `src/mcp/main.ts` and from the assistant service must not reach `humanApproval.ts` or `service/operator.ts`; the assistant service object is frozen and its exact key set is asserted. Limitation: the walk is regex-based and would miss imports built from computed strings (none exist today).
- **Error sanitization.** Unexpected exceptions return `internal_error` with a fixed message; a test closes the store mid-session and checks for no stack frames or absolute paths. Root-missing scans return `root_unavailable` without the path. Path stripping is pattern-based (common Unix and Windows roots), defense in depth rather than a guarantee.
- **Replay.** Request keys are scoped to project and operation, bound to a hash of the canonical request, and written in the same transaction as the record they protect. Keys do not expire yet, and the stored result is rebuilt from current records (so a replayed proposal reports its current status).
- **Cross-project ids.** Proposals and findings that cite a source from another project are refused (`wrong_project`); a test checks a rescan of one project changes nothing in another.

### Allowlist review: does discovery honor the documented roots?
- Supported names are matched exactly and case-sensitively. On case-insensitive volumes (default macOS), `agents.md` or `claude.md` would be loaded by some clients; Agentlore now reports them as `case_variant_name` (not read) instead of ignoring them.
- `node_modules`, `.git`, `dist`, `build`, `out`, `target` and similar folders are skipped; a real AGENTS.md there (for example a package named `build/`) is not audited. They are now counted and the scan is marked partial.
- Folders deeper than 16 levels were silently dropped before; they are now counted and reported.
- Symlinks (files and folders) are never followed, including the common `CLAUDE.md -> AGENTS.md` pattern. They are reported as `symlink_not_followed`, and `scope_resolve` lists them as presence-only, so a client that does load them is not misrepresented as loading nothing.
- `@import` lines are never followed. `.claude/AGENTS.md` is not a documented Claude Code location and is not read.
- Not fixed: hard-linked instruction files are refused at read time (`nlink > 1`), which also hides legitimate hard links some tools create.

## Milestone 4 review: freshness and onboarding (Nov 9, 2026)
- **Freshness is a hint, not a guard.**
  - Metadata equality is never used for evidence or apply; those still compare SHA-256 of bytes. A test rewrites a file with the same size and restored mtime and checks that apply refuses with `stale_on_disk`.
  - A source-level test asserts that the guard modules do not reference freshness.
- **No new read paths.**
  - Freshness only `lstat`s files the last scan recorded, through the same component-by-component walk that refuses symlinks and paths outside the root. It never opens files.
  - Results contain source ids, relative paths of already-listed sources, and enum states. They contain no absolute paths, error strings or content (tested).
- **Roots.**
  - A missing root, a root that is now a symlink, or a root folder replaced by a new directory (different dev or inode) gives `unknown`, never "no changes" (tested for all three).
  - Residual: a root replaced by a different real directory at the same path passes `verifyRegisteredRoot`, so **a rescan will read the new folder**. Freshness flags `root_replaced` until then, but nothing blocks the rescan. Accepted for now because the user registered that path and anyone able to replace it could also edit files inside it. Possible follow-up: require `project add` again when the root identity changes.
- **Hard links.** A recorded file that gains a second link is `unsafe`, consistent with scan and apply refusing hard-linked files.
- **Doctor** opens the workspace database with `readOnly: true`, never creates the workspace folder (tested), and reports environment variable *names* only (tested with a fake secret in the environment). It prints absolute local paths, because it runs only in the user's own terminal.
- **Demo safety.** `--reset` no longer deletes a demo that holds proposals unless `--discard-proposals` is given (tested). The default demo path is still under `$TMPDIR`, which the OS may clean.
- **Residual:** freshness and status run `lstat` for up to `LIMITS.maxSources` files per project on every status call. That is a bounded cost, with no caching.

## Website milestone review: local bridge and static site (Nov 9, 2026)

Threat model: a hostile web page in the same browser (DNS rebinding, cross-site requests), hostile instruction text inside a scanned project (XSS, link injection) and accidental exposure of private data in the static build.

Defenses, each covered by tests:
- The bridge binds 127.0.0.1 only. Host must be `127.0.0.1:<port>` or `localhost:<port>`, otherwise 421, which defeats DNS rebinding. Any Origin other than the bridge's own gets 403, and cross-site `Sec-Fetch-Site` gets 403. Non-GET/HEAD requests get 405. There are no CORS headers.
- There are no routes for scan, propose, approve, apply, root registration, shell or file paths. Unknown routes and traversal attempts get 404. The import-graph test proves the bridge cannot reach the operator or human-approval code.
- API responses are `no-store, private` and never include absolute paths or proposal digests. Internal errors return a generic message.
- Rendering uses text nodes only (no `innerHTML`; the build test scans for it). Links come from a fixed allowlist of routes and three documentation URLs, never from instruction text. The e2e test checks that `<img onerror>` and `<script>` in files and rationales stay text.
- The CSP is `default-src 'none'` with self-hosted scripts and styles only. The build audit fails on external URLs, private paths or `sk-`-style tokens.

Residual risks (not fixed):
- Any process running as the same user can read the bridge, just as it can read the workspace file directly.
- Browser extensions with page access can read what the page shows.
- `localhost` is accepted as a Host alias; a system with an unusual hosts file could map it elsewhere, but the socket still only listens on 127.0.0.1.
- Secret detection is pattern-based. Redacted content is safer, not guaranteed clean.
- The static site has not been reviewed for public hosting, and no host's headers have been checked. A host must send the same CSP and security headers.

## Alpha verification review: package, large fixtures, root identity (Nov 9, 2026)

Fixed:
- **A replaced root was rescanned silently.** Before this, if the registered folder was deleted and a different folder created at the same path, the next scan read the new folder as if it were the same project, and apply could write into it. Now the project's device and inode are recorded when it is registered (or at the first scan for older workspaces). Scans check them before discovery and again after it; apply checks them before writing. A mismatch refuses, records nothing and is audited as `scan_refused`. Only a person running `project add <same path>` re-confirms it, audited as `project_root_reconfirmed`. Covered by `tests/rootIdentity.test.ts`, including a swap during a scan and an apply with byte-identical files in the replacement folder.
- **The package build could ship stale code.** The repo `.npmrc` sets `ignore-scripts=true`, so `prepack` never runs. `pack:check` now builds explicitly and checks the result.

Package review (`npm run pack:check`, `npm run install:check`):
- 40 files on a strict allowlist. There are no install, preinstall or postinstall scripts in the package or its 3 runtime dependencies, and no native builds. Nothing points at the repository checkout.
- The installed MCP server exposes the same 13 tools with no approve or apply. The installed CLI's approve/apply human gates were not exercised (the test terminal is agent-driven, so they refuse).
- `npm audit`: 0 known vulnerabilities (5 production, 15 development packages) at the time of the run. That is a point-in-time advisory check, not a security guarantee.

Large-fixture review (`tests/largeFixture.test.ts`, `npm run load:test`):
- Every instruction-named file the generator creates is either read or listed as not read with a reason, except the one below the depth limit, which is counted in `skipped`. Partial coverage is reported whenever anything is skipped, truncated or excluded, so a partial scan is never reported as clean.
- Source bytes are hashed before and after scan, freshness, propose, retries and concurrent writers; none changed. Approval is still bound to the reviewed proposal's byte hash, and a stale base refuses at approve (`stale_version`) or at apply (`stale_on_disk`).
- The synthetic secret in the fixture is never returned unredacted.

Still open: risks 1–8 above (except that root replacement is now handled), plus:
- The 50,000-entries-per-directory limit and file counts above about 5,000 were not tested.
- Node 24 (the declared minimum) was not tested; only Node 26.8.2 on macOS arm64.
- No real assistant client has used the installed package. Grok Bot cannot attach a stdio server on this Mac today (see `docs/ALPHA_VERIFICATION.md`).

## Alpha release review: 0.1.0-alpha.1 (Nov 9, 2026)

- The tarball is made from a staged copy, so the repository keeps `"private": true`. The staged manifest drops `scripts` and `devDependencies`, so the published package declares no lifecycle scripts at all.
- Release files in `artifacts/release/` are never overwritten. The sha512 is recorded before the install checks and the dry run and compared after them. The publish command names that exact file.
- Contents: `package.json`, `README.md`, `LICENSE`, 2 bins and the compiled `build/**/*.js`. There are no sources, tests, workspaces, databases, backups or git data.
- Auth policy followed (npm docs, read Nov 9, 2026): publishing needs 2FA or a granular token. No token was created, read or stored by an agent; the person signs in and answers 2FA themselves.
- Not claimed: real-client compatibility; a person running approve/apply end to end; Windows or Linux support.
