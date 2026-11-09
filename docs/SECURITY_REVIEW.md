# Adversarial review: slice 1 (Nov 9, 2026)

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
