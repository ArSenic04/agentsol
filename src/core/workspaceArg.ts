import path from "node:path";

/** Workspace directory from an explicit flag or env var only; callers fall back with resolveWorkspace. */
export function workspaceFrom(argv: readonly string[], env: NodeJS.ProcessEnv): { dir: string | null; rest: string[] } {
  const rest: string[] = [];
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--workspace") {
      dir = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith("--workspace=")) {
      dir = a.slice("--workspace=".length);
    } else {
      rest.push(a);
    }
  }
  // Older names still work: AGENTLORE_WORKSPACE and AGENTWEAVE_WORKSPACE (earlier product names).
  const fromEnv = nonEmpty(env["AGENTSOL_WORKSPACE"]) ?? nonEmpty(env["AGENTLORE_WORKSPACE"]) ?? nonEmpty(env["AGENTWEAVE_WORKSPACE"]);
  return { dir: dir ?? fromEnv, rest };
}

function nonEmpty(v: string | undefined): string | null {
  return v !== undefined && v.length > 0 ? v : null;
}

/** The flag or env var if given, else `<home>/.agentsol`, the location every install guide uses. */
export function resolveWorkspace(argv: readonly string[], env: NodeJS.ProcessEnv, home: string): { dir: string; isDefault: boolean; rest: string[] } {
  const { dir, rest } = workspaceFrom(argv, env);
  return dir ? { dir, isDefault: false, rest } : { dir: path.join(home, ".agentsol"), isDefault: true, rest };
}
