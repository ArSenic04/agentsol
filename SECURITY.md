# Security policy

Agentsol is early alpha software. It runs locally, has no server or account, and sends nothing anywhere by itself.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on https://github.com/ArSenic04/agentsol/security/advisories/new. Please do not open a public issue for a security problem.

Include the Agentsol version (`agentsol --version`), your OS and Node version, and the steps or input that show the problem. Use made-up secrets in examples, never real ones.

You should get a reply within 7 days. Fixes ship as a new alpha on npm, with a regression test and a note in `docs/RELEASE_LOG.md`.

## Supported versions

Only the latest `agentsol@alpha` on npm gets fixes.

## What counts

Especially welcome:
- any way an AI agent (over MCP, hooks or the CLI) can approve, apply or reject a proposal, or write a project file, without a person at the terminal;
- secrets or file contents leaking through MCP tool results, session review, `doctor`, logs or the website;
- the guard hook blocking or hanging when it should fail open, or allowing a command its rules should stop;
- path escapes: reading or writing outside a registered project or the workspace.

Known limits, which are documented rather than bugs: an agent with full shell access can fake a person at a terminal, and secret masking is pattern-based and can miss secrets it does not recognize. See `docs/SECURITY_REVIEW.md`.
