/**
 * Local CLI for the person who owns the workspace. Read and propose operations go
 * through the same assistant-safe service as MCP; human-only decisions go through the
 * operator service. All output is sanitized because file text and rationale are untrusted.
 */
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { detectAgentEnvironment } from "../core/agentEnv.ts";
import { sanitizeForTerminal } from "../core/display.ts";
import { isProposalId } from "../core/ids.ts";
import { createAssistantService } from "../core/service/assistant.ts";
import type { ServiceResult } from "../core/service/errors.ts";
import { createOperatorService, type Review } from "../core/service/operator.ts";
import type { ProjectStatus } from "../core/service/status.ts";
import { WorkspaceStore } from "../core/store.ts";
import { workspaceFrom } from "../core/workspaceArg.ts";

const USAGE = `agentweave --workspace <dir> <command> [--json]

Commands (human-run, local only):
  project add <path> [--name <name>]   register a project folder (never home, /, system or broad folders)
  projects                              list registered projects (with local paths)
  status [--json]                       workspace status: scans, partial coverage, stale findings, proposals
  scan <projectId> [--json]             discover instruction files and run deterministic checks
  sources <projectId> [--json]          list sources and instruction files not read
  findings <projectId> [--json]         list current structural and possible (assistant-reported) findings
  proposals <projectId>                 list proposals
  review <proposalId>                   show a proposal's diff and fingerprint
  approve <proposalId>                  approve (interactive terminal only; type the one-time code shown)
  reject <proposalId>                   reject a proposal (interactive terminal only)
  apply <proposalId>                    apply an approved proposal (interactive terminal only)
  reconcile <proposalId>                resolve a proposal stuck in "applying" after a crash
  audit [entityId]                      show the audit log
`;

const out = (s: string): void => {
  process.stdout.write(`${sanitizeForTerminal(s)}\n`);
};
const fail = (s: string, code = 1): number => {
  process.stderr.write(`agentweave: ${sanitizeForTerminal(s)}\n`);
  return code;
};
const actor = (): string => `local-user:${userInfo().username}`;
const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Reads one line from the terminal. Ctrl+C, Ctrl+D or a closed input count as "cancel". */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    process.stdout.write("\n");
    return "";
  } finally {
    rl.close();
  }
}

const humanOnly = (command: string): number | null => {
  const agent = detectAgentEnvironment(process.env);
  if (agent) return fail(`${command} is for a person, and this terminal looks like it is run by ${agent.agent} (${agent.variable} is set). Run it yourself in a normal terminal.`, 2);
  if (!isInteractive()) return fail(`${command} must be run by a person in an interactive terminal`, 2);
  return null;
};

/** Prints a service result: JSON when asked, otherwise a text renderer. */
function show<T>(r: ServiceResult<T>, json: boolean, text: (v: T) => void): number {
  if (!r.ok) {
    if (json) process.stdout.write(`${JSON.stringify({ error: r.error }, null, 2)}\n`);
    return fail(`${r.error.code}: ${r.error.message}`, r.error.code === "invalid_input" || r.error.code === "not_found" ? 2 : 1);
  }
  if (json) process.stdout.write(`${JSON.stringify(r.value, null, 2)}\n`);
  else text(r.value);
  return 0;
}

function renderStatus(p: ProjectStatus): void {
  const scan = p.scan.state === "never_scanned" ? "never scanned: nothing is known yet"
    : p.scan.state === "refused" ? `scan refused at ${p.scan.at}: ${p.scan.reason}`
    : `scanned ${p.scan.at}${p.scan.partial ? " (PARTIAL)" : ""}`;
  out(`${p.projectId}  ${p.name}\n  ${scan}`);
  if (p.scan.state === "scanned") for (const r of p.scan.partialReasons) out(`    - ${r}`);
  out(`  sources: ${p.sources.present} present, ${p.sources.missing} missing, ${p.sources.withRedactedLines} with redacted lines; ${p.notRead.total} instruction file(s) not read`);
  out(`  findings: ${p.findings.structural} structural, ${p.findings.semantic} possible, ${p.findings.staleHidden} hidden as stale`);
  const pr = p.proposals;
  out(`  proposals: ${pr.pending} pending (${pr.pendingOnOldVersion} on an old version), ${pr.applying} applying, ${pr.stale} stale, ${pr.applied} applied, ${pr.rejected} rejected`);
}

function renderReview(r: Review): void {
  const p = r.proposal;
  out(`proposal ${p.body.id}  status=${p.status}  file=${p.body.relPath}`);
  out(`author: ${p.body.author}   created: ${p.body.createdAt}`);
  out(`rationale: ${p.body.rationale}`);
  if (r.linkedFindings.length > 0) out(`linked findings: ${r.linkedFindings.join(", ")}`);
  if (!r.baseIsCurrent) out("WARNING: the source changed since this proposal was made; it cannot be applied.");
  out(r.diff);
  out("\nThe rationale and file text above were written by an assistant or a repository author. Read the diff itself before approving.");
  if (p.status === "pending") out(`fingerprint: ${r.fingerprint}`);
}

async function run(argv: string[]): Promise<number> {
  const { dir, rest: withFlags } = workspaceFrom(argv, process.env);
  const json = withFlags.includes("--json");
  const rest = withFlags.filter((a) => a !== "--json");
  const [command, ...args] = rest;
  if (!command || command === "help" || command === "--help") {
    out(USAGE);
    return command ? 0 : 2;
  }
  if (!dir) return fail("pass --workspace <dir> or set AGENTWEAVE_WORKSPACE", 2);
  let store: WorkspaceStore;
  try {
    store = WorkspaceStore.open(dir);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "could not open workspace", 2);
  }
  try {
    const svc = createAssistantService(store, {
      reporter: actor,
      onInternalError: (op, e) => process.stderr.write(`agentweave: ${op} internal error: ${e instanceof Error ? e.message : String(e)}\n`),
    });
    const ops = createOperatorService(store, { actor, homeReal: await realpath(homedir()) });
    const arg = args[0] ?? "";
    switch (command) {
      case "project": {
        if (args[0] !== "add") return fail("usage: project add <path> [--name <name>]", 2);
        const rest2 = args.slice(1);
        const nameIdx = rest2.indexOf("--name");
        const name = nameIdx >= 0 ? rest2[nameIdx + 1] : undefined;
        const target = rest2.find((a, i) => !a.startsWith("--") && (nameIdx < 0 || i !== nameIdx + 1));
        if (!target) return fail("project add needs a path", 2);
        const r = await ops.registerProject(target, name);
        if (!r.ok) return fail(r.error.message, 2);
        if (r.value.alreadyRegistered) out(`already registered: ${r.value.project.id} ${r.value.project.name}`);
        else {
          out(`registered ${r.value.project.id} ${r.value.project.name} (${r.value.project.rootReal})`);
          out("Only AGENTS.md, AGENTS.override.md, CLAUDE.md and SKILL.md files in this folder are read. CLAUDE.local.md, symlinks and secret-like names are skipped.");
        }
        return 0;
      }
      case "projects":
        for (const p of ops.listProjectsWithRoots()) out(`${p.id}  ${p.name}  ${p.rootReal}`);
        return 0;
      case "status":
        return show(svc.status(), json, (s) => {
          if (s.projects.length === 0) out("No projects registered.");
          for (const p of s.projects) renderStatus(p);
          out("");
          for (const c of s.caveats) out(`note: ${c}`);
        });
      case "scan":
        return show(await svc.scan({ projectId: arg }), json, (v) => out(JSON.stringify(v, null, 2)));
      case "sources":
        return show(svc.listSources({ projectId: arg }), json, (v) => {
          for (const s of v.sources) out(`${s.sourceId}  ${s.status.padEnd(7)}  ${s.format.padEnd(18)}  ${s.relPath}${s.redactedLineCount > 0 ? `  (${s.redactedLineCount} redacted line(s))` : ""}`);
          for (const e of v.notRead) out(`not read  ${e.reason.padEnd(22)}  ${e.relPath}`);
        });
      case "findings":
        return show(svc.listFindings({ projectId: arg }), json, (v) => {
          if (v.staleHidden > 0) out(`(${v.staleHidden} finding(s) cite older file versions and are hidden; run scan to refresh)`);
          for (const f of v.findings) {
            const label = f.kind === "structural" ? "FACT" : "POSSIBLE (assistant-reported, unverified)";
            const where = f.evidence.map((e) => `${e.relPath}:${e.startLine}-${e.endLine}`).join(", ");
            out(`${f.id}  ${f.checkId}  ${f.severity.padEnd(5)}  ${label}\n    ${f.title}\n    ${f.message}\n    evidence: ${where}`);
          }
        });
      case "proposals": {
        const exists = svc.projectStatus({ projectId: arg });
        if (!exists.ok) return fail(exists.error.message, 2);
        for (const p of store.listProposals(exists.value.projectId)) out(`${p.body.id}  ${p.status.padEnd(8)}  ${p.body.relPath}  by ${p.body.author}`);
        return 0;
      }
      case "review": {
        const r = ops.review(arg);
        if (!r.ok) return fail(r.error.message, 2);
        renderReview(r.value);
        return 0;
      }
      case "approve": {
        if (!isProposalId(arg)) return fail("approve needs a proposalId", 2);
        const refused = humanOnly("approve");
        if (refused !== null) return refused;
        const shown = ops.review(arg);
        if (!shown.ok) return fail(shown.error.message, 2);
        renderReview(shown.value);
        const challenge = randomBytes(4).toString("hex");
        const typed = await ask(`\nTo approve exactly this change, type ${challenge} (anything else cancels): `);
        if (typed.trim() !== challenge) return fail("cancelled; nothing was approved", 1);
        const r = ops.approve({ proposalId: arg, reviewedProposalSha256: shown.value.proposal.body.proposalSha256 });
        if (!r.ok) return fail(`not approved: ${r.error.message}`);
        out(`approved (${r.value}); valid for 10 minutes, once. Run: agentweave apply ${arg}`);
        return 0;
      }
      case "reject": {
        if (!isProposalId(arg)) return fail("reject needs a proposalId", 2);
        const refused = humanOnly("reject");
        if (refused !== null) return refused;
        const r = ops.reject(arg);
        if (!r.ok) return fail(r.error.message);
        out("rejected");
        return 0;
      }
      case "apply": {
        if (!isProposalId(arg)) return fail("apply needs a proposalId", 2);
        const refused = humanOnly("apply");
        if (refused !== null) return refused;
        const answer = await ask(`Apply ${arg} to the file on disk? A backup is kept in the workspace. Type "apply" to continue: `);
        if (answer.trim() !== "apply") return fail("cancelled", 1);
        const r = await ops.apply(arg);
        if (!r.ok) return fail(`not applied (${r.error.code}): ${r.error.message}`);
        out(`applied to ${r.value.relPath}; backup at ${r.value.backupPath}${r.value.rescanned ? "" : " (rescan failed; run scan)"}`);
        return 0;
      }
      case "reconcile": {
        if (!isProposalId(arg)) return fail("reconcile needs a proposalId", 2);
        out(`reconcile: ${await ops.reconcile(arg)}`);
        return 0;
      }
      case "audit":
        for (const e of ops.audit(arg || undefined)) out(`${e.at}  ${e.actor}  ${e.action}  ${e.entity_id}  ${e.detail}`);
        return 0;
      default:
        out(USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

process.exitCode = await run(process.argv.slice(2));
