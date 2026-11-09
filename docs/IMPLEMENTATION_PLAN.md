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
- [ ] Manual test with a real Claude client (Claude Desktop or Claude Code) against a synthetic project, set up by the owner
- [ ] Package as a Claude Desktop extension (.mcpb) or an `npx` entry; not done yet
- [ ] `.cursor/rules`, `.claude/rules`, user-level and managed files (out of scope for slice 1)
- [ ] Hosted workspace (later; the engine in `src/core` has no MCP or CLI dependencies)

## Persistence decision
One SQLite file (`workspace.sqlite`, through `node:sqlite`) in a workspace directory that you pass explicitly with `--workspace` or `AGENTWEAVE_WORKSPACE`. There is no hidden default location. The directory is created with mode 0700 and backups are written with mode 0600. Tests use throwaway temp directories.

## Next smallest unit
Connect the MCP server to Claude Code or Claude Desktop by hand, using a synthetic demo project. Write down the exact config and what the client shows, then add a `demo/` fixture plus a script that creates it.
