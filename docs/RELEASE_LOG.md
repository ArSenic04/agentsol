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
