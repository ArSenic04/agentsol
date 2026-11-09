import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectId } from "../src/core/ids.ts";
import { WorkspaceStore } from "../src/core/store.ts";

/** All fixtures are synthetic and live in fresh temp directories. */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `agentlore-test-${prefix}-`)));
}

export async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

export type Fixture = { root: string; wsDir: string; store: WorkspaceStore; projectId: ProjectId; cleanup: () => Promise<void> };

export async function fixture(files: Record<string, string | Uint8Array>): Promise<Fixture> {
  const base = await tempDir("fx");
  const root = path.join(base, "project");
  const wsDir = path.join(base, "workspace");
  await mkdir(root);
  await writeTree(root, files);
  const store = WorkspaceStore.open(wsDir);
  const project = store.addProject({ name: "fixture", rootReal: root });
  return {
    root,
    wsDir,
    store,
    projectId: project.id,
    cleanup: async () => {
      store.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

export const sourceByPath = (store: WorkspaceStore, projectId: ProjectId, relPath: string) => {
  const s = store.listSources(projectId).find((x) => x.relPath === relPath);
  if (!s || !s.currentVersionId) throw new Error(`fixture source missing: ${relPath}`);
  const v = store.getVersion(s.currentVersionId);
  if (!v) throw new Error("fixture version missing");
  return { source: s, version: v };
};

/** Drops wall-clock check times so results taken a moment apart compare equal. */
export function withoutTimes(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutTimes);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "checkedAt").map(([k, x]) => [k, withoutTimes(x)]));
  return v;
}
