/**
 * Deterministic SYNTHETIC monorepo generator for load and edge-case tests. Nothing here
 * comes from a real project. Layout (per package i):
 *   packages/p<i>/AGENTS.md            shared lines across packages (duplicates, not conflicts)
 *   packages/p<i>/CLAUDE.md            every 5th package, imports @AGENTS.md
 *   packages/p<i>/AGENTS.override.md   every 7th package
 *   packages/p<i>/src/feature/AGENTS.md  every 2nd package (nested scope)
 *   packages/p<i>/skills/skill-<j>/SKILL.md  valid; every 10th package has one malformed
 *   packages/p<i>/src/a/b/c/*.ts|json  non-instruction files (counted, never read)
 * plus node_modules/ and .git/ (never walked), a secret-like folder, and one copy of each
 * edge case: invalid UTF-8, binary, over 256 KiB, symlink, hard link, FIFO, case variant,
 * CLAUDE.local.md, too-deep folder, empty file, secret-like text. `overflow` adds extra
 * instruction files to push past the 500-source limit.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type BigFixtureOptions = { packages: number; otherFilesPerPackage: number; skillsPerPackage: number; overflow?: number; edges?: boolean };
export type BigFixtureStats = { instructionFiles: number; otherFiles: number; ignoredDirFiles: number; directories: number; totalFiles: number };

export const SHARED_LINE = "- Always run the unit tests before you commit.";
export const FAKE_SECRET = "sk-FAKEFAKEFAKEFAKEFAKEFAKE1234567890";

export async function generateBigProject(root: string, o: BigFixtureOptions): Promise<BigFixtureStats> {
  const s: BigFixtureStats = { instructionFiles: 0, otherFiles: 0, ignoredDirFiles: 0, directories: 0, totalFiles: 0 };
  const dirs = new Set<string>();
  const put = async (rel: string, content: string | Buffer, kind: "instruction" | "other" | "ignored"): Promise<void> => {
    const abs = path.join(root, rel);
    const d = path.dirname(abs);
    if (!dirs.has(d)) {
      await mkdir(d, { recursive: true });
      dirs.add(d);
    }
    await writeFile(abs, content);
    if (kind === "instruction") s.instructionFiles += 1;
    else if (kind === "other") s.otherFiles += 1;
    else s.ignoredDirFiles += 1;
  };

  await put("AGENTS.md", `# Synthetic monorepo\n${SHARED_LINE}\n- Use npm to run scripts.\n- Keep pull requests small.\n`, "instruction");
  await put("CLAUDE.md", "@AGENTS.md\n@docs/guide.md\n@docs/missing.md\n", "instruction");
  await put("docs/guide.md", "# Guide\nSynthetic.\n", "other");
  for (let i = 0; i < 20; i++) await put(`.git/objects/${i}/AGENTS.md`, "# not a real git object\n", "ignored");
  for (let i = 0; i < Math.max(5, Math.floor(o.packages / 2)); i++) {
    await put(`node_modules/dep${i}/AGENTS.md`, "# dependency instructions are not project instructions\n", "ignored");
    await put(`node_modules/dep${i}/index.js`, "module.exports = {};\n", "ignored");
  }
  await put("secrets/AGENTS.md", "# must never be opened\n", "ignored");

  for (let i = 0; i < o.packages; i++) {
    const p = `packages/p${i}`;
    const tool = i % 3 === 0 ? "pnpm" : "npm";
    await put(`${p}/AGENTS.md`, `# Package p${i}\n${SHARED_LINE}\n- Use ${tool} to run scripts in this package.\n- Owner: team-${i % 4}.\n`, "instruction");
    if (i % 5 === 0) await put(`${p}/CLAUDE.md`, "@AGENTS.md\n- Prefer small diffs.\n", "instruction");
    if (i % 7 === 0) await put(`${p}/AGENTS.override.md`, `# Override for p${i}\n- Use yarn here.\n`, "instruction");
    if (i % 2 === 0) await put(`${p}/src/feature/AGENTS.md`, `# Feature scope\n${SHARED_LINE}\n- Feature flags live in flags.ts.\n`, "instruction");
    for (let j = 0; j < o.skillsPerPackage; j++) {
      const name = `skill-${i}-${j}`;
      const body = i % 10 === 0 && j === 0
        ? "---\nname: [unclosed\ndescription: broken yaml\n---\nBody.\n"
        : `---\nname: ${name}\ndescription: Synthetic skill ${j} for package ${i}.\n---\n# ${name}\nDo the synthetic thing.\n`;
      await put(`${p}/skills/${name}/SKILL.md`, body, "instruction");
    }
    for (let k = 0; k < o.otherFilesPerPackage; k++) {
      const depth = ["src", "src/a", "src/a/b", "src/a/b/c", "test"][k % 5];
      const ext = k % 4 === 0 ? "json" : "ts";
      await put(`${p}/${depth}/file${k}.${ext}`, ext === "json" ? `{"id":${k},"pkg":${i}}\n` : `export const v${k} = ${i * 1000 + k};\n// AGENTS.md is mentioned here but this is not an instruction file\n`, "other");
    }
  }

  if (o.edges !== false) {
    await put("edge/invalid-utf8/AGENTS.md", Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]), "instruction");
    await put("edge/binary/AGENTS.md", Buffer.from([0x23, 0x00, 0x01, 0x02, 0x0a]), "instruction");
    await put("edge/large/AGENTS.md", `# Large\n${"- filler line for size limit testing\n".repeat(8000)}`, "instruction");
    await mkdir(path.join(root, "edge/symlink"), { recursive: true });
    await symlink("../../AGENTS.md", path.join(root, "edge/symlink/AGENTS.md"));
    s.instructionFiles += 1;
    await put("edge/hardlink/source.txt", "# hard linked content\n", "other");
    await link(path.join(root, "edge/hardlink/source.txt"), path.join(root, "edge/hardlink/AGENTS.md"));
    s.instructionFiles += 1;
    if (process.platform !== "win32") {
      await mkdir(path.join(root, "edge/fifo"), { recursive: true });
      const fifo = spawnSync("mkfifo", [path.join(root, "edge/fifo/AGENTS.md")]);
      if (fifo.status !== 0) throw new Error("mkfifo failed");
      s.instructionFiles += 1;
    }
    await put("edge/case/agents.md", "# lowercase name\n", "instruction");
    await put("edge/local/CLAUDE.local.md", "# personal\n", "instruction");
    await put(`edge/${Array.from({ length: 18 }, (_, k) => `d${k}`).join("/")}/AGENTS.md`, "# too deep\n", "instruction");
    await put("edge/empty/AGENTS.md", "", "instruction");
    await put("edge/secret/AGENTS.md", `# Secret\n- token ${FAKE_SECRET}\n`, "instruction");
    await put("edge/malformed/SKILL.md", "no frontmatter at all\n", "instruction");
  }
  for (let k = 0; k < (o.overflow ?? 0); k++) await put(`overflow/o${k}/AGENTS.md`, `# Overflow ${k}\n- Synthetic.\n`, "instruction");
  s.directories = dirs.size;
  s.totalFiles = s.instructionFiles + s.otherFiles + s.ignoredDirFiles;
  return s;
}

/** sha256 of every regular file (symlinks and FIFOs listed by kind, never opened). */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out.set(r, createHash("sha256").update(await readFile(path.join(root, r))).digest("hex"));
      else {
        const st = await lstat(path.join(root, r));
        out.set(r, `${e.isSymbolicLink() ? "symlink" : "special"}:${st.ino}`);
      }
    }
  };
  await walk("");
  return out;
}

export function diffSnapshots(a: Map<string, string>, b: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) changed.push(k);
  for (const k of b.keys()) if (!a.has(k)) changed.push(`+${k}`);
  return changed;
}
