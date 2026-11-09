import { realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { applyApprovedProposal, approveProposal, confirmationCode, rejectProposal } from "../core/humanApproval.ts";
import { isProjectId, isProposalId } from "../core/ids.ts";
import { isStrictlyInside } from "../core/paths.ts";
import { renderDiff } from "../core/proposals.ts";
import { scanProject } from "../core/scan.ts";
import { WorkspaceStore } from "../core/store.ts";
import { workspaceFrom } from "../core/workspaceArg.ts";

const USAGE = `agentweave --workspace <dir> <command>

Commands (human-run, local only):
  project add <path> [--name <name>]   register a project root (never your home or / directory)
  projects                              list registered projects
  scan <projectId>                      discover instruction files and run deterministic checks
  sources <projectId>                   list sources and exclusions
  findings <projectId>                  list structural and possible (assistant-reported) findings
  proposals <projectId>                 list proposals
  review <proposalId>                   show a proposal's diff and confirmation code
  approve <proposalId>                  approve (interactive terminal only; type the code)
  reject <proposalId>                   reject a proposal
  apply <proposalId>                    apply an approved proposal (interactive terminal only)
  audit [entityId]                      show the audit log
`;

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const fail = (s: string, code = 1): number => {
  process.stderr.write(`agentweave: ${s}\n`);
  return code;
};
const actor = (): string => `local-user:${userInfo().username}`;
const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Reads one line from the terminal. Ctrl+C, Ctrl+D or a closed input count as "cancel" (empty answer). */
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

async function addProject(store: WorkspaceStore, args: string[]): Promise<number> {
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  const target = args.find((a, i) => !a.startsWith("--") && (nameIdx < 0 || i !== nameIdx + 1));
  if (!target) return fail("project add needs a path", 2);
  let rootReal: string;
  try {
    rootReal = await realpath(path.resolve(target));
    if (!(await stat(rootReal)).isDirectory()) return fail("not a directory", 2);
  } catch {
    return fail("path does not exist", 2);
  }
  const home = await realpath(homedir());
  if (rootReal === path.parse(rootReal).root || rootReal === home || isStrictlyInside(rootReal, home)) return fail("refusing to register the filesystem root or your home directory; pick a project folder", 2);
  if (rootReal === store.dir || isStrictlyInside(store.dir, rootReal)) return fail("refusing to register the workspace directory itself", 2);
  const existing = store.findProjectByRoot(rootReal);
  if (existing) {
    out(`already registered: ${existing.id} ${existing.name}`);
    return 0;
  }
  const project = store.addProject({ name: name ?? path.basename(rootReal), rootReal });
  store.audit({ actor: actor(), action: "project_registered", entityId: project.id });
  out(`registered ${project.id} ${project.name} (${rootReal})`);
  return 0;
}

async function review(store: WorkspaceStore, id: string): Promise<number> {
  const p = isProposalId(id) ? store.getProposal(id) : null;
  if (!p) return fail("unknown proposal", 2);
  const base = store.getVersion(p.body.baseVersionId);
  const source = store.getSource(p.body.sourceId);
  out(`proposal ${p.body.id}  status=${p.status}  file=${p.body.relPath}`);
  out(`author: ${p.body.author}   created: ${p.body.createdAt}`);
  out(`rationale: ${p.body.rationale}`);
  if (p.body.findingIds.length > 0) out(`linked findings: ${p.body.findingIds.join(", ")}`);
  if (source?.currentVersionId !== p.body.baseVersionId) out("WARNING: the source changed since this proposal was made; it cannot be applied.");
  if (base) out(renderDiff(p.body.relPath, base.lines, p.body.edits));
  if (p.status === "pending") out(`\nconfirmation code: ${confirmationCode(p.body)}  (type it with: agentweave approve ${p.body.id})`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const { dir, rest } = workspaceFrom(argv, process.env);
  const [command, ...args] = rest;
  if (!command || command === "help" || command === "--help") {
    out(USAGE);
    return command ? 0 : 2;
  }
  if (!dir) return fail("pass --workspace <dir> or set AGENTWEAVE_WORKSPACE", 2);
  const store = WorkspaceStore.open(dir);
  try {
    const arg = args[0] ?? "";
    switch (command) {
      case "project":
        if (args[0] !== "add") return fail("usage: project add <path> [--name <name>]", 2);
        return await addProject(store, args.slice(1));
      case "projects":
        for (const p of store.listProjects()) out(`${p.id}  ${p.name}  ${p.rootReal}`);
        return 0;
      case "scan": {
        if (!isProjectId(arg)) return fail("scan needs a projectId", 2);
        const r = await scanProject(store, arg, actor());
        if (!r.ok) return fail(r.error);
        out(JSON.stringify(r.value, null, 2));
        return 0;
      }
      case "sources":
        if (!isProjectId(arg)) return fail("sources needs a projectId", 2);
        for (const s of store.listSources(arg)) out(`${s.id}  ${s.status.padEnd(7)}  ${s.format.padEnd(18)}  ${s.relPath}`);
        for (const e of store.listExclusions(arg)) out(`excluded  ${e.reason.padEnd(22)}  ${e.relPath}`);
        return 0;
      case "findings":
        if (!isProjectId(arg)) return fail("findings needs a projectId", 2);
        for (const f of store.listFindings(arg)) {
          const label = f.kind === "structural" ? "FACT" : "POSSIBLE (assistant-reported, unverified)";
          const where = f.evidence.map((e) => `${e.relPath}:${e.startLine}-${e.endLine}`).join(", ");
          out(`${f.id}  ${f.checkId}  ${f.severity.padEnd(5)}  ${label}\n    ${f.title}\n    ${f.message}\n    evidence: ${where}`);
        }
        return 0;
      case "proposals":
        if (!isProjectId(arg)) return fail("proposals needs a projectId", 2);
        for (const p of store.listProposals(arg)) out(`${p.body.id}  ${p.status.padEnd(8)}  ${p.body.relPath}  by ${p.body.author}`);
        return 0;
      case "review":
        return await review(store, arg);
      case "approve": {
        if (!isProposalId(arg)) return fail("approve needs a proposalId", 2);
        if (!isInteractive()) return fail("approve must be run by a person in an interactive terminal", 2);
        await review(store, arg);
        const code = await ask("\nType the confirmation code to approve (anything else cancels): ");
        if (code.trim() === "") return fail("cancelled; nothing was approved", 1);
        const r = approveProposal(store, { proposalId: arg, confirmCode: code, decidedBy: actor() });
        if (!r.ok) return fail(`not approved: ${r.error.message}`);
        out(`approved (${r.value}). Run: agentweave apply ${arg}`);
        return 0;
      }
      case "reject": {
        if (!isProposalId(arg)) return fail("reject needs a proposalId", 2);
        const r = rejectProposal(store, { proposalId: arg, decidedBy: actor() });
        if (!r.ok) return fail(r.error.message);
        out("rejected");
        return 0;
      }
      case "apply": {
        if (!isProposalId(arg)) return fail("apply needs a proposalId", 2);
        if (!isInteractive()) return fail("apply must be run by a person in an interactive terminal", 2);
        const answer = await ask(`Apply ${arg} to the file on disk? A backup is kept in the workspace. Type "apply" to continue: `);
        if (answer.trim() !== "apply") return fail("cancelled", 1);
        const r = await applyApprovedProposal(store, { proposalId: arg, actor: actor() });
        if (!r.ok) return fail(`not applied (${r.error.code}): ${r.error.message}`);
        out(`applied to ${r.value.relPath}; backup at ${r.value.backupPath}`);
        const p = store.getProposal(arg);
        if (p) await scanProject(store, p.body.projectId, actor());
        return 0;
      }
      case "audit":
        for (const e of store.listAudit(arg || undefined)) out(`${e.at}  ${e.actor}  ${e.action}  ${e.entity_id}  ${e.detail}`);
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
