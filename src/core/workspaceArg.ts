/** Workspace directory comes only from an explicit flag or env var; there is no implicit default. */
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
  const fromEnv = env["AGENTWEAVE_WORKSPACE"];
  return { dir: dir ?? (fromEnv && fromEnv.length > 0 ? fromEnv : null), rest };
}
