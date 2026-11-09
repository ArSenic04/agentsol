# Agentlore implementation plan: slice 1 (local engine, MCP server and CLI)

Goal: the smallest end-to-end loop someone can verify. Import instruction files, record versions, run deterministic checks, let an assistant read, audit and propose over MCP, and keep approval and apply with the human in a local CLI.

## Checklist
- [x] Project scaffold: Node >= 24 with native TypeScript, strict tsc, exact-pinned dependencies, `ignore-scripts`
- [x] Safe paths: no traversal, absolute paths, NUL or backslash; symlinks never followed; realpath checked inside the root
- [x] Discovery of AGENTS.md, AGENTS.override.md, CLAUDE.md (plus `.claude/CLAUDE.md`), CLAUDE.local.md and SKILL.md, with limits on file size, depth, directory entries and source count
- [x] Exclusions recorded with a reason: secret-like names, symlinks, binary, invalid UTF-8, too large, limits reached
- [x] Secret redaction before storage (only redacted text and the raw hash are stored), with line numbers preserved
- [x] Source versions (a new version only when the bytes change); missing files marked missing
- [x] Structural checks: D00 empty; D01–D04 skill frontmatter, name, description, compatibility; D07 size; D08 precedence; D09 CLAUDE imports; D10 duplicates ("not a conflict"); D12 secrets
- [x] Scope resolution for Codex, Claude Code (default setting) and Cursor (AGENTS.md only), always reported as "layered"
- [x] Evidence validation for assistant findings: ids, project, current version, line range, exact quote
- [x] Proposals as structured line edits with expected text; never written to disk at proposal time
- [x] Human approval: TTY plus typed confirmation code, bound to the proposal digest and base hash, single use
- [x] Apply: on-disk hash re-check, no-follow read, backup in the workspace, temp file and atomic rename, EOL/BOM preserved, mixed EOL refused
- [x] MCP stdio server with 10 tools and no approve or apply tool; tested over a real process in legacy (2025-11-25) and auto (2026-07-28) negotiation
- [x] CLI for project registration, scan, review, approve, reject, apply and audit
- [x] Adversarial review pass 1 (docs/SECURITY_REVIEW.md): root validation, name minimization, hard links, inode-verified reads, transactional single-active approvals with TTL, crash reconcile, terminal sanitizing, agent-environment refusal, working-directory scope model
- [x] Synthetic demo (`npm run demo`), proposes over real MCP stdio and never writes the project
- [ ] Manual test with a real Claude client (Claude Desktop or Claude Code) against a synthetic project, set up by the owner
- [ ] Package as a Claude Desktop extension (.mcpb) or an `npx` entry; not done yet
- [ ] `.cursor/rules`, `.claude/rules`, user-level and managed files (out of scope for slice 1)
- [ ] Hosted workspace (later; the engine in `src/core` has no MCP or CLI dependencies)

## Persistence decision
One SQLite file (`workspace.sqlite`, through `node:sqlite`) in a workspace directory that you pass explicitly with `--workspace` or `AGENTLORE_WORKSPACE` (or the older `AGENTWEAVE_WORKSPACE`). There is no hidden default location. The directory is created with mode 0700 and backups are written with mode 0600. Tests use throwaway temp directories.

## Milestone 3: shared workspace service (done)
- `src/core/service/assistant.ts`: the only surface MCP (and a future web client) may use. Typed `ServiceResult` for list/scan/read/scope/checks/findings/propose/status. Frozen object; no approve, reject, apply, register or reconcile.
- `src/core/service/operator.ts`: register, review, approve, reject, apply, reconcile, audit. Imported only by the CLI. A test walks the import graph from `src/mcp/main.ts` and from the assistant service and fails if `humanApproval.ts` or `operator.ts` is reachable.
- `src/core/service/errors.ts`: public error codes (`not_found`, `invalid_input`, `wrong_project`, `stale_version`, `rejected`, `root_unavailable`, `request_key_conflict`, `internal_error`). Messages strip absolute paths and terminal-unsafe characters; unexpected exceptions become `internal_error` and details go only to a local stderr sink.
- `src/core/service/status.ts` + `workspace_status` tool + `agentlore status`: per project scan state (`never_scanned`, `refused` with reason, `scanned` with `partial` and reasons), present/missing sources, sources with redacted lines, files not read by reason, current vs stale-hidden findings, proposal counts including pending proposals whose base version is no longer current. No file text, no paths.
- Replay protection: optional `requestKey` on `findings_submit` and `change_propose`, stored per project and operation with a SHA-256 of the canonical request. Same key + same request returns the stored result (`replayed: true`); same key + different request returns `request_key_conflict`; failed requests do not consume a key. Independently of keys, an identical pending proposal (same source, version and edits) or an identical finding returns the existing id. This means "the same change was already recorded", not "the change is correct".
- Discovery now reports, instead of silently dropping: folders beyond the depth limit, skipped generated/dependency folders (`node_modules`, `dist`, `build`, ...), case-variant names (`agents.md`, `claude.md`), and symlinked instruction files (presence only in `scope_resolve`).
- Store: schema v3 (`scans`, `request_keys`), nested transactions via savepoints.

## Still unsupported (explicitly)
- Instruction formats other than AGENTS.md, AGENTS.override.md, CLAUDE.md, .claude/CLAUDE.md and SKILL.md. Not read: CLAUDE.local.md, `.claude/rules/`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, GEMINI.md, `.claude/AGENTS.md`, user-level and managed files.
- `@import` targets are never read or followed; only whether they exist is checked (secret-like targets are not even checked).
- Symlinked instruction files (for example `CLAUDE.md -> AGENTS.md`) are never followed; they are reported as present but not read, so their content is not audited.
- Files inside skipped folders (`node_modules`, `dist`, `build`, `out`, `target`, ...) or deeper than 16 levels are not read; the scan is marked partial.
- Status counts reflect the last scan; status does not re-check the disk, so a file edited after the scan is not flagged until the next scan.
- Request keys are optional; an assistant that sends a different key (or none) for a semantically similar but not identical request creates a second record.
- No auth, server routes, web UI or multi-user support. One local OS user is the trust boundary.
- Real MCP client walkthroughs (Claude Code, Codex, Cursor) and a human interactive approve/apply after the milestone-3 refactor remain unverified.

## Milestone 4: honest freshness and first-run onboarding (done)
- `src/core/fileMeta.ts` + `src/core/freshness.ts`:
  - At scan time, each read source's `lstat` metadata (dev, ino, size, mtime ns, ctime ns, nlink) is stored in `source_observations`, and the root folder's dev and ino in `root_observations` (schema v4, additive).
  - Metadata is taken from the open handle before the bytes are read, so a mid-read write shows up as a change later.
  - `checkFreshness` re-runs `lstat` through the symlink-refusing path walk and never reads content.
- States:
  - Per source: `metadata_unchanged`, `changed`, `removed`, `unsafe`, `unknown`.
  - Per project:
    - `not_checked`: never scanned.
    - `unknown`: `root_unavailable`, `root_replaced` or `no_root_metadata`.
    - `changes_detected`, `incomplete` or `no_known_changes`.
  - A recorded file that gains a hard link is `unsafe`. An observation recorded for a different version than the current one (for example after an apply whose rescan failed) is `unknown`.
- Surfaces:
  - `ProjectStatus.freshness`, plus `findings.basis = "last_scan_snapshot"`.
  - Assistant service `freshness()`, MCP `sources_freshness`, and CLI `freshness <projectId> [--json]`. The CLI output equals MCP except `checkedAt`.
  - `status` now returns a Promise because it performs `lstat`.
- Freshness is not imported by `humanApproval.ts`, `proposals.ts`, `evidence.ts` or `semantic.ts`, and a test enforces that. Apply still refuses by byte hash when the size and mtime have been restored.
- `npm run doctor` (`scripts/doctor.mjs`, then `src/cli/doctor.ts`):
  - Checks Node (plain-JS version gate first), node:sqlite, the lockfile against installed versions of the direct dependencies, workspace existence, privacy and symlink state, the schema version (opened read-only), and whether the terminal is agent-driven.
  - Prints the exact CLI and MCP commands and an MCP config with absolute paths.
  - Never creates, migrates or writes the workspace. No network. Never prints environment variable values.
- Demo:
  - Rerunning keeps the existing demo and prints its proposals and next commands, with exit 0.
  - `--reset` refuses while proposals exist unless `--discard-proposals` is passed.
  - Expected refusals print one line without a stack trace.

## Still unsupported after milestone 4
- Freshness cannot detect new instruction files, renames into supported names, or changes to excluded files (symlinks, case variants, skipped folders) without a scan.
- Equal metadata is not proof of equal content. A same-size rewrite with restored mtime is caught on macOS only because ctime changes; filesystems with coarse or unreliable timestamps (some network or FUSE mounts) may miss changes.
- Workspaces created by earlier versions report `unknown` / `no_root_metadata` until each project is rescanned.
- Doctor checks direct dependencies only (not the full tree) and does not run `npm audit` (that needs network).
- Only Node 26.8.2 on macOS has been run. The declared `>=24` floor is untested.

## Next smallest unit (after milestone 4)
A person (Shivam) runs the walkthrough on the existing synthetic demo in a normal terminal: `npm run doctor`, `status`, `review`, `approve` and `apply` for the pending demo proposal, then `status` again. Record each command's output and any confusing step. This is the first human validation of the approval path since milestone 2 and needs no assistant client. Software follow-up (agent-doable): a `scan --if-changed` option, or a status hint, that tells the user to rescan when freshness reports changes.

## Website milestone: product site and read-only workspace view (done, local only)

- `web/`: framework-free TypeScript site (landing, interactive synthetic demo, read-only workspace view, setup guide). It uses type-only imports from the core via `web/src/contract.ts`.
- `scripts/buildWeb.ts`: transpiles into `dist/web`, records demo data by running the real core on the synthetic demo files, and audits the output for private paths, secret-like tokens and external loads. It refuses to delete a folder it did not build.
- `src/web/`: loopback bridge (`api.ts`, `server.ts`, `main.ts`) over the assistant service. It is GET/HEAD only, checks Host and Origin and Sec-Fetch-Site, sends no CORS headers, marks API responses no-store/private, uses a strict CSP, serves static files from a startup manifest without symlinks, and sanitizes errors. It does not import the operator or humanApproval modules (enforced by the import-graph test).
- New read-only service method `listProposals` and MCP tool `changes_list` (no digest exposed). The CLI `proposals` command uses it.
- Tests: `tests/web/*.test.ts` (in `npm run check`) and `tests/e2e/site.e2e.ts` (browser, `npm run test:web`).

## Still unsupported after the website milestone

- No hosted deployment, accounts, payments, waitlist, contact form or public download. No repository link until one exists.
- No scanning from the browser; scanning stays in the CLI so GET stays side-effect free.
- No validation inside Claude Code, Codex, Cursor or other assistant apps.
- No screen-reader or formal WCAG audit; checks so far are automated (keyboard, focus, reduced motion, overflow) plus visual review.

## Next smallest unit (after the website milestone)

A human review of the site copy and screenshots, then an accessibility pass with VoiceOver, then a decision on a static host for `dist/web` only.

## Alpha verification milestone (done, local only, not published)

- Root identity: device and inode recorded at registration and enforced at scan and apply. `project add` re-confirms a replaced folder.
- Package: `tsconfig.build.json`, `scripts/buildPackage.ts`, `bin/*.mjs` (Node >= 24 guard), `scripts/packCheck.ts` (allowlist and content audit), `scripts/installCheck.ts` (clean install into a temp folder, CLI plus MCP against the installed copy). Doctor understands installed-package mode.
- Large synthetic fixtures: `scripts/bigFixture.ts`, `tests/largeFixture.test.ts` and `tests/rootIdentity.test.ts`; `scripts/loadTest.ts` for 3 bounded tiers (about 1,800 to 5,000 files).
- Results: `docs/ALPHA_VERIFICATION.md`.

## Rename and website refresh: Agentlore (done, local only)

- Brand, title, wordmark, favicon, meta, accessibility labels and setup commands now say Agentlore. The hero has a code-drawn diagram (instruction files, Agentlore, your assistant, you), with slow motion that stops under reduced motion.
- New section "Bring your assistant" separates what is verified (SDK client, installed package, refusal in agent terminals) from what it is built for but has not validated (Claude Code, Codex, Cursor).
- Package and binaries: `agentlore`, `agentlore-mcp`; MCP server name `agentlore`; `AGENTLORE_WORKSPACE` with `AGENTWEAVE_WORKSPACE` as a fallback. The demo, web-build and package-build markers accept the old names. The database is unchanged.
- Not renamed: the source folder, git history and historical notes.

## Alpha gates (all need a person)

1. Choose a licence. It is `UNLICENSED` today.
2. Confirm the package name and npm account. The product is now Agentlore (`agentlore` returned 404 on npm on Nov 9, 2026; not reserved). `agentweave` is taken.
3. Publish from your own account, removing `"private": true` on purpose. No agent publishes.
4. Connect one real MCP client (for example Claude Code) by hand to the installed tarball, and record what it shows.
5. Run approve and apply yourself, in a normal terminal, on the pending demo proposal.

## Still unsupported after alpha verification

- Grok Bot as a connector: it attaches only remote HTTPS servers or command servers on its own cloud computer, not stdio servers on this Mac.
- Node 24, Windows, Linux, more than about 5,000 files, and directories near the 50,000-entry limit are untested.

## Older next units
### After review pass 1
The workspace product needs a small "workspace service" layer in `src/core` that the CLI, the MCP server and a later hosted workspace all call. Commands such as register, scan, list and propose would go through it, with typed results, instead of each entry point calling store functions directly. Then add a read-only `status` view (projects, pending proposals, stale findings) as its first consumer.

## Earlier next unit
Connect the MCP server to Claude Code or Claude Desktop by hand, using a synthetic demo project. Write down the exact config and what the client shows, then add a `demo/` fixture plus a script that creates it.
