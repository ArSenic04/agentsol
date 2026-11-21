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
