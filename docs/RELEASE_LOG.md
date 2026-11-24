# Release log

## 0.1.0-alpha.1: prepared, NOT published (Nov 9, 2026, 5:00 PM EST)

- Release file: `artifacts/release/agentlore-0.1.0-alpha.1.tgz` (local, gitignored)
  - 42 files, 56,189 bytes
  - integrity `sha512-Py66eqc0dWk+ormTNm3TBTNf0zYvOHR9FnyFM5s5zSygC2AwYgMC7yrkljQzdnS7k8yeGrQAp6KZtt00SUf3Cg==`
  - sha256 `11f761a92e12c7db005052e498ac4d6a6f2cebc5b9a4f0b521033752a9aa54af`
  - The full gate record is in `<tarball>.release.json`.
- Gates passed (`npm run release:check`):
  - release pack audit;
  - clean install, CLI and MCP stdio on Node 24.0.0, 24.22.2 and 26.8.2 (macOS arm64), 21/21 checks each;
  - `npm publish --dry-run` on the exact file with tag `alpha` and public access;
  - sha512 unchanged after all checks.
- Registry: https://registry.npmjs.org/agentlore returned 404 `{"error":"Not found"}` just before packing. Nothing is reserved.
- Blocker: npm is not signed in on this Mac (`npm whoami` reports "need auth").
- Next steps, all done by a person in a normal terminal on the Mac:
  1. Run `npm login`. The browser sign-in asks for your 2FA.
  2. Run `npm publish ./artifacts/release/agentlore-0.1.0-alpha.1.tgz --tag alpha --access public --registry https://registry.npmjs.org/` and answer the 2FA prompt.
  3. Verify with `npm view agentlore@alpha`, then do a clean install from the registry.
- npm docs read Nov 9, 2026:
  - https://docs.npmjs.com/cli/v12/commands/npm-publish
  - https://docs.npmjs.com/cli/v12/commands/npm-login
  - https://docs.npmjs.com/cli/v11/commands/npm-dist-tag
  - https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/
  - https://docs.npmjs.com/about-access-tokens/
  - https://docs.npmjs.com/trusted-publishers/

### Publish attempt 1: refused by npm, nothing published (Nov 9, 2026, 4:55 PM EST)
- Signed in as `shivam0411` (`npm whoami`). The release file was re-verified first: same sha256 `11f761a9…a54af`, and `release:check --existing` passed on Node 24.0.0, 24.22.2 and 26.8.2, plus the dry run.
- `npm publish ./artifacts/release/agentlore-0.1.0-alpha.1.tgz --tag alpha --access public` returned `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
- `npm profile get "two-factor auth"` reports `disabled`. Afterwards the registry still returned 404 for `agentlore` and for `agentlore@0.1.0-alpha.1`, and the tarball was unchanged.
- Human step: turn on 2FA on npmjs.com (Account → Two-Factor Authentication → Enable 2FA; https://docs.npmjs.com/configuring-two-factor-authentication), then publish the same file again with its 2FA prompt.

### Publish attempt 2: needs an interactive 2FA prompt, nothing published (Nov 9, 2026, 5:01 PM EST)
- `npm whoami`: `shivam0411`; 2FA mode `auth-and-writes`. Registry returned 404 for `agentlore`; tarball sha256 unchanged (`11f761a9…a54af`).
- `npm publish` returned `EOTP: This operation requires a one-time password` and exited, because the agent's shell has no terminal for npm to wait on. It printed a one-time browser sign-in link and a token-retrieval link. The agent did not open either, and did not retrieve any token.
- Registry still 404 afterwards; tarball unchanged.
- Human step: run the same publish command in your own Terminal (see below); npm then waits for the browser approval or the code itself.

## Agentsol 0.1.0-alpha.1 (Nov 9, 2026, America/Toronto)
- Renamed Agentlore -> Agentsol; source folder moved to `~/Projects/agentsol`. The Agentlore tarball above is kept unchanged and will never be published.
- Registry check 5:12 PM EST: `agentsol` and 22 punctuation/spacing variants plus close spellings (agentsole, agentsoul, agentsols, agent-sol, agentsolo, agentsolver) returned 404; npm search for "agentsol" returned nothing. npm may still apply its own similarity rule at publish time.
- Release file: `artifacts/release/agentsol-0.1.0-alpha.1.tgz`, 42 files, 56,271 bytes, sha256 6776f6e4f13faa9666bfd64595c52c00211f2ae01af0fe59fc6435c5f335b117, integrity sha512-d8viGMhETjGzyawa7X8I/aKsXSK5wRe6vIf1fVsNukIGxiOsPVGrhz4xuA93q4kyHGwPiVXtlpCzc/RryQ78mg==.
- `release:check --existing` READY: clean install + CLI + MCP 21/21 on Node 24.0.0, 24.22.2, 26.8.2; dry run tag alpha, public.
- Publish attempt 5:16 PM EST from a non-interactive shell: npm stopped with EOTP (one-time password / browser auth required). Not retried. Registry after: agentsol 404 (nothing published). Next step: run the publish command in Terminal yourself.
- Released 5:19 PM EST (2026-11-09T22:19:30Z) after the user's interactive publish; npm first showed only the 0.0.0-stage placeholder (staged-publishing flow) until about 5:20 PM. Live check 5:21 PM: dist-tags alpha=0.1.0-alpha.1 AND latest=0.1.0-alpha.1 (npm set latest; not changed by us). MIT, node >=24, bins agentsol/agentsol-mcp, maintainer shivam0411, 42 files, no scripts. Registry tarball sha256 and sha512 match the release file exactly.
- Registry install (empty npm cache, scripts disabled) 21/21 on Node 24.0.0, 24.22.2, 26.8.2; plain `npm install agentsol` resolves 0.1.0-alpha.1.

## Agentsol 0.2.0-alpha.3: prepared, NOT published (Nov 21, 2026, 3:23 PM EST)
- Ships the field-evaluation fixes in `docs/EVALUATION.md`: fewer false alarms in `check` (D08, D09, D10, D12, D13, D15) and `inspect`, new `inspect` findings (credential theft, `.env` commits, "Never forget to:" lists), compaction-aware `learn`, heredocs skipped in `learn`, review diffs that keep unchanged lines as context.
- 0.2.0-alpha.2 was prepared but never published; its tarball is kept unchanged. Publish alpha.3 instead.
- Release file: `artifacts/release/agentsol-0.2.0-alpha.3.tgz`, 48 files, 140,651 bytes, sha256 5b114ba7f879f93e78fbd21b3ac6818e50503a2fc1e4dba1ba644a6de4003cfb, integrity sha512-OpWGp5vXe2XQ8PGV+O6HgUpLrv03P8L2ZY5JzB2uJKlDMT2T2X6SO4xU7x2iZax7x5iTHY4f8j5asaLAifEiFQ==.
- `release:check` READY: pack audit; sha512 equals npm pack; clean install + CLI + MCP 21/21 on Node 26.8.2 and 25.9.0; `npm publish --dry-run` tag alpha, public; tarball unchanged.
- Next steps (a person, in Terminal): `npm publish ./artifacts/release/agentsol-0.2.0-alpha.3.tgz --tag alpha --access public --registry https://registry.npmjs.org/`, then `npm dist-tag add agentsol@0.2.0-alpha.3 latest`.

## Agentsol 0.2.0-alpha.4: prepared, NOT published (Nov 22, 2026)
- Replaces the unpublished alpha.3 (its tarball is kept unchanged): alpha.3 lacks `mcpName`, which the MCP Registry needs to verify the npm package.
- Adds since alpha.3: check D16 (instructions name a package manager the project doesn't use); fewer `inspect` false alarms (danger 27 → 22 on 1,567 public items); commands in boxes wrap instead of being cut off; next steps match how agentsol was run (npx or installed); "did you mean" for unknown commands; `agentsol log` for the audit log; clearer MCP tool descriptions; `learn` time-lost counts only failed steps; `server.json` and a Claude Code plugin marketplace.
- Release file: `artifacts/release/agentsol-0.2.0-alpha.4.tgz`, 48 files, 144,698 bytes, sha256 e426f5b0277e14bd954c476f4a6e7fac537391466bb1483fdced012b0644b2cf, integrity sha512-PT0Sls/kwm5ipA11UGaC4oS4JzLU+aOFDbpm3l/sjfsoAS1q4lR1NzwScf9mFj+DgiAagK7NDAv39x6HQXFpfw==.
- `release:check` READY: pack audit; sha512 equals npm pack; clean install + CLI + MCP 21/21 on Node 26.8.2 and 25.9.0; dry run tag alpha, public; tarball unchanged.
- Next steps (a person): `npm publish ./artifacts/release/agentsol-0.2.0-alpha.4.tgz --tag alpha --access public --registry https://registry.npmjs.org/`; `npm dist-tag add agentsol@0.2.0-alpha.4 latest`; then `mcp-publisher login github` and `mcp-publisher publish` in the repo.

## Agentsol 0.2.0-alpha.5: prepared, NOT published (Nov 23, 2026)
- Supersedes the unpublished alpha.4 (tarball kept unchanged). Publish alpha.5.
- New: `agentsol guard`, a pre-command hook (Claude Code block + ask, Codex block, Gemini CLI block + warning) that blocks the wrong package manager and commands past sessions show fail, and asks before dangerous ones; replay on 1,178 real agent commands: 0 blocked, 0 asked. `check --sarif` / `--sarif-file` and a GitHub Action (`action.yml`). `npm run eval:learn`: 35 labelled histories; held-out precision 100%, recall 89%, no leaks. `learn` ignores network, rate-limit and sandbox failures and learns wrong-folder paths.
- Release file: `artifacts/release/agentsol-0.2.0-alpha.5.tgz`, 51 files, 160,158 bytes, sha256 d1f34577f39da28f3f2672a78317c0b4c1ae7fdbf3cf0b3bec1484036591cc66, integrity sha512-WbmoVltHXxMGqlqntWfbxiTu8LRr2TCxYcFRykqZt4N5xqoqQfhNAl/wsIQkucTnbzVMOXXouoInRYjMJCmAxQ==.
- `release:check` READY on Node 26.8.2 and 25.9.0 (21/21 each, dry run tag alpha, public, tarball unchanged). Also verified from the installed tarball: `guard --test`, hook-mode JSON, and `check --sarif`.
- Next steps (a person): `npm publish ./artifacts/release/agentsol-0.2.0-alpha.5.tgz --tag alpha --access public --registry https://registry.npmjs.org/`; `npm dist-tag add agentsol@0.2.0-alpha.5 latest`; `mcp-publisher login github` then `mcp-publisher publish`.

## Agentsol 0.2.0-alpha.6: published (Nov 23, 2026, 1:52 PM EST)
- Published by a person to npm under the `alpha` tag; the registry integrity matches the release file below. `latest` and `alpha` both point to 0.2.0-alpha.6.
- Supersedes the unpublished alpha.5 (tarball kept unchanged).
- Hardening after an independent review and a red-team (113-command table in tests): commands longer than 20,000 characters are asked about instead of passing on padding; six missed dangers now caught; a lock-write failure no longer loses the decision; `CLAUDECODE=1` counts as an agent; Windows hook quoting. `connect --guard` keeps a symlinked settings.json a symlink. SARIF fingerprints follow the flagged line's text; the Action skips upload on fork PRs and its default version is the exact release. `doctor` warns about a stale node path.
- `eval:learn` held-out set rebuilt without dev overlap: 27 scenarios, precision 100%, recall 86%, fix correct 86%, no leaks (dev 21: 100%). Guard replay on 1,187 real agent commands: 0 blocked, 0 asked.
- Release file: `artifacts/release/agentsol-0.2.0-alpha.6.tgz`, 51 files, 162,000 bytes, sha256 b73da4af816babdcecd4803c6350e2064ac1724fa667feaf8221f2b332fbcb0c, integrity sha512-7ZG5Fw9jk5C1i1AlWCoQrPCV95Zuyy6HCuUmvXI2Fz6ouso35AXtZT/WmgNEQ/ouXDEMS9cHgxU0VieASAmN8Q==.
- `release:check` READY on Node 25 (dry run tag alpha, public, tarball unchanged). Verified from the installed tarball: `guard --test` denies `npm test` in a pnpm project, a padded `curl | sh` is asked about, `connect claude-code --guard` keeps a symlinked settings.json, `check --sarif` reports D16 at AGENTS.md:2.
- Listed in the official MCP Registry as `io.github.ArSenic04/agentsol` 0.2.0-alpha.6, status active (Nov 23, 2026, 4:17 PM EST).

## Agentsol 0.2.0-alpha.7: published (Nov 24, 2026)
- Guard works across agent apps: `agentsol connect --guard` finds Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI and Cline, asks per app, and adds a session-start hook (the project briefing lands in the agent's context with no tool call) plus the pre-command check, each in that app's own hook format. `--remove` takes them out; other hooks are kept. Only Claude Code was tested live; the others are covered by format tests.
- Guard hooks written from a Homebrew Node use its `opt` link instead of the versioned `Cellar` path, so `brew upgrade node` no longer breaks them. `connect --guard --remove` without a terminal now says "Remove them yourself" instead of showing setup text.
- `learn` treats TLS failures (`SSL_ERROR_*`, `gnutls_handshake() failed`, `TLS handshake timeout`) as the network's fault, so a flaky connection no longer turns `git push` into a "never worked" lesson.
- Published by a person to npm under the `alpha` tag; `latest` and `alpha` both point to 0.2.0-alpha.7 and the registry integrity matches the release file: 51 files, 165,163 bytes, integrity sha512-8HIVj04FWw0o6av7+rqSf2cCP7lywP8C9WWJ3c248qufQz4EJwiI+hBwDeISKJkDnWpTmHspIhoMsKnfHKApQg==.
- `release:check` READY on Node 26.8.2. Listed in the official MCP Registry as 0.2.0-alpha.7, latest.

## Agentsol 0.2.0-alpha.8: prepared (Nov 24, 2026)
- Windows works: the workspace privacy check used POSIX mode bits, which Windows does not have (it reports 0o666 for every folder), so every command failed with "accessible by other users". On Windows the check now relies on the user folder's permissions. `start` also finds apps installed as `claude.cmd` or `.exe` (PATHEXT) and prints their connect commands.
- CI on every push: tests on Linux, macOS and Windows (Node 24 and 26), pack audit and clean install on Linux and Windows, website tests. Workflow actions pinned by commit. The tests now fake the home folder on Windows too (USERPROFILE).
- The website is built and deployed from this repository (`.github/workflows/pages.yml`) at https://arsenic04.github.io/agentsol/; the separate site repository is retired.
- `SECURITY.md` (private reporting), repo guide in `AGENTS.md` with `CLAUDE.md` importing it, README session GIF and tests badge.
- Website: shorter landing page built around the agent loop (learn, brief, guard, you approve); the hero shows a session with the real briefing and block. The install page adds a `connect --guard` step.

## Unreleased
- GitHub Action installs the exact Agentsol version into its own folder instead of using npx, which could run another copy (a global install or a checked-out repository named agentsol). CI now runs the Action itself on Linux and Windows.
