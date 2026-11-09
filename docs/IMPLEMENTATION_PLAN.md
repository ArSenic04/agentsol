# AgentWeave implementation plan: slice 1 (local engine, MCP server and CLI)

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
One SQLite file (`workspace.sqlite`, through `node:sqlite`) in a workspace directory that you pass explicitly with `--workspace` or `AGENTWEAVE_WORKSPACE`. There is no hidden default location. The directory is created with mode 0700 and backups are written with mode 0600. Tests use throwaway temp directories.

## Milestone 3: shared workspace service (done)
- `src/core/service/assistant.ts`: the only surface MCP (and a future web client) may use. Typed `ServiceResult` for list/scan/read/scope/checks/findings/propose/status. Frozen object; no approve, reject, apply, register or reconcile.
- `src/core/service/operator.ts`: register, review, approve, reject, apply, reconcile, audit. Imported only by the CLI. A test walks the import graph from `src/mcp/main.ts` and from the assistant service and fails if `humanApproval.ts` or `operator.ts` is reachable.
- `src/core/service/errors.ts`: public error codes (`not_found`, `invalid_input`, `wrong_project`, `stale_version`, `rejected`, `root_unavailable`, `request_key_conflict`, `internal_error`). Messages strip absolute paths and terminal-unsafe characters; unexpected exceptions become `internal_error` and details go only to a local stderr sink.
- `src/core/service/status.ts` + `workspace_status` tool + `agentweave status`: per project scan state (`never_scanned`, `refused` with reason, `scanned` with `partial` and reasons), present/missing sources, sources with redacted lines, files not read by reason, current vs stale-hidden findings, proposal counts including pending proposals whose base version is no longer current. No file text, no paths.
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

## Next smallest unit (after milestone 3)
Make status detect "changed since last scan" without reading content: record size and mtime per source at scan time and compare with `lstat` when status is requested, reporting `changedSinceScan` per project. Measurable: a test edits a file after scanning and status flags it; no file text is read. Separately (needs Shivam, not an agent): run the demo in one real MCP client and do one interactive approve/apply on the synthetic demo.

## Next smallest unit (after review pass 1)
The workspace product needs a small "workspace service" layer in `src/core` that the CLI, the MCP server and a later hosted workspace all call. Commands such as register, scan, list and propose would go through it, with typed results, instead of each entry point calling store functions directly. Then add a read-only `status` view (projects, pending proposals, stale findings) as its first consumer.

## Earlier next unit
Connect the MCP server to Claude Code or Claude Desktop by hand, using a synthetic demo project. Write down the exact config and what the client shows, then add a `demo/` fixture plus a script that creates it.
