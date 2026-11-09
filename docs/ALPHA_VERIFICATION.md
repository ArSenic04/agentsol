# Alpha verification (Nov 9, 2026)

This was a local run on one Mac (Apple M1 Pro, 10 cores, 16 GiB, Node 26.8.2, darwin-arm64). Nothing was published, pushed or deployed. All fixtures are synthetic temp folders.

## Commands and results
| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 81/81 pass (74 earlier + 4 root identity + 3 large fixture) |
| `npm run test:web` | 11/11 pass |
| `npm run pack:check` | pass, 0 problems |
| `npm run install:check` | 18/18 pass |
| `npm run load:test` | 3 tiers, 0 source bytes changed |
| `npm audit` | 0 known vulnerabilities (5 prod, 15 dev), point in time |

## Package
- Tarball: `artifacts/pack/agentweave-0.1.0.tgz` (40 files, 54743 bytes packed, 196102 unpacked).
- sha256 `a819c40fb72a0855190d3843d610029c0f9b766c02427bad953bedabcfe9b19f`. This changes with every rebuild; recompute it with `npm run pack:check`.
- Contents: `package.json`, `README.md`, `bin/agentweave.mjs`, `bin/agentweave-mcp.mjs`, and 36 compiled files under `build/core`, `build/cli`, `build/mcp`. There is no TypeScript source, tests, web code, docs, lockfile or `.npmrc`.
- The package has no install-time scripts. The 3 runtime dependencies (`@modelcontextprotocol/sdk`, `yaml`, `zod`) and their manifests declare none either.
- Clean install: a fresh temp folder with `npm install --ignore-scripts <tarball>`. It ran help, doctor, project add, scan, findings and an MCP stdio handshake with 5 tool calls against the installed copy. Project bytes were unchanged, and no repository path appeared in the installed files.
- Name: `agentweave` is taken on the public npm registry (https://registry.npmjs.org/agentweave returns an unrelated package, v0.1.2). We need a scoped name owned by your npm account. Nothing was reserved.
- Licence: `UNLICENSED`, and there is no LICENSE file. That's your decision.
- Node: only 26.8.2 was tested. The declared minimum (>= 24) is not tested.

## Load (synthetic monorepos, `npm run load:test`)
Method:
- Each tier runs in its own child process.
- Times are wall clock (`performance.now`) for a single run; they are not averages.
- Peak RSS is the highest `process.memoryUsage().rss` sampled every 5 ms during the operation. It includes the generator's leftover memory in the same process.
- These numbers describe this machine on this day only.

| Tier | Files on disk | Instruction-named | Sources read | Not read (with reason) | First scan ms | Unchanged rescan ms | Freshness ms | Status ms | Peak RSS MiB | DB KiB | Findings | Bytes changed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t1-2k | 2280 | 207 | 198 | 8 | 156 | 140 | 44 | 53 | 134 | 396 | 99 | 0 |
| t2-5k | 5022 | 399 | 390 | 8 | 305 | 259 | 84 | 93 | 139 | 636 | 186 | 0 |
| t3-over-limit | 1822 | 699 | 500 | 198 | 289 | 230 | 79 | 84 | 113 | 952 | 441 | 0 |

- The t3 tier exceeds the 500-source limit. 190 files are reported as `limit_reached`, and status reports partial coverage.
- In every tier: instruction-named files = sources read + not read + 1 below the depth limit (counted in `skipped`). Nothing is dropped silently.
- An unchanged rescan records 0 new versions.
- Each tier includes the edge cases: invalid UTF-8, binary, over 256 KiB, symlink, hard link, FIFO, `agents.md` case variant, `CLAUDE.local.md`, depth 18, an empty file, a fake secret, malformed SKILL.md frontmatter, a `secrets/` folder, `node_modules` and `.git`.
- Not tested: more than about 5,000 files, directories near the 50,000-entry limit, network or slow disks, other machines.

## Defects found and fixed in this unit
1. **A different folder at a registered path was scanned as the same project.** Fixed with a device and inode identity check at scan (before and after discovery) and at apply. A person re-confirms with `project add`. Covered by `tests/rootIdentity.test.ts`.
2. **The package build could be stale.** `ignore-scripts=true` in `.npmrc` skips `prepack`, so `pack:check` now builds explicitly.
3. **The MCP server reported version 0.2.0 while the package was 0.1.0.** Aligned to 0.1.0.
4. **Doctor assumed it ran from a repo checkout.** It now detects installed-package mode, checks the installed dependency versions and prints launch commands for `bin/*.mjs`.

## Grok Bot connector feasibility
Sources:
- https://docs.x.ai/grok-bot/computer-and-apps. A bot can add an MCP server by URL, or by a command that runs on its own (cloud) computer, which is separate from the Mac.
- Third-party guides quoting staff replies (botcookbook.com, grokbotwiki.com, plugandship.dev) and an X post (https://x.com/grok/status/2115351609085473213). They say local stdio or localhost servers on your laptop are not attached, and remote servers need public HTTPS with OAuth.
- The plugin catalog has no AgentWeave entry.

Conclusion: AgentWeave runs as a stdio server on the Mac, so Grok Bot cannot attach it as a connector today. Nothing was attached or configured. The SDK client tests are protocol tests, not a connector test.

Options, each needing your decision:
- (a) Allow installing the tarball on the bot's cloud computer as a command server. It would only see files on that computer, not your Mac projects.
- (b) Wait for a supported local bridge.
- (c) Build a hosted HTTPS server with OAuth. This is a large redesign that conflicts with local-first.

Today, Grok Bot can only run the CLI on the Mac with per-command approval, which is not MCP.

Other clients: a `claude` zsh shell function exists on this Mac. `codex` and `cursor` are not on PATH; `cursor-agent` is. None was launched or configured; no credentials or paid sessions were used.

## Remaining alpha gates (need a person)
1. Licence. 2. Package name or scope. 3. A publish account (and removing `"private": true` deliberately). 4. One real MCP client connected by hand to the installed tarball. 5. Approve and apply run by you in a normal terminal.
