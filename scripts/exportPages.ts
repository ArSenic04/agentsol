/**
 * Exports the built website as a GitHub Pages-ready folder of public files only.
 * Usage: node scripts/exportPages.ts --out <dir>
 *  - builds the site into a temp folder (scripts/buildWeb.ts), copies only the public files,
 *  - drops the internal build marker, adds .nojekyll, a short README and the LICENSE,
 *  - adds a <meta> Content-Security-Policy, because GitHub Pages cannot send custom headers.
 *    A meta CSP cannot express frame-ancestors (clickjacking), sandbox or reporting, and
 *    nosniff / Permissions-Policy cannot be set at all; those protections are absent there.
 *  - refuses to write into a folder that holds anything other than an earlier export (+ .git),
 *  - re-runs the privacy audit on the exported files.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditOutput } from "./buildWeb.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAGES_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests";
export const EXPORTED = new Set([".git", ".nojekyll", "README.md", "LICENSE", "index.html", "styles.css", "favicon.svg", "js"]);
const README = `# Agentsol website (published files only)

Static files for the Agentsol website, served by GitHub Pages. They are generated from a separate private source repository; nothing here is the product source.

- Package: https://www.npmjs.com/package/agentsol (early alpha, MIT)
- The demo on this site uses a made-up project recorded at build time. There are no forms, analytics, cookies or third-party scripts, and the site makes no network requests of its own.
- GitHub Pages cannot send custom security headers, so the Content-Security-Policy is a <meta> tag. That cannot prevent other sites from framing the page (frame-ancestors).
`;

export async function exportPages(out: string): Promise<string[]> {
  if (existsSync(out)) {
    const extra = (await readdir(out)).filter((e) => !EXPORTED.has(e));
    if (extra.length) throw new Error(`${out} contains files that are not part of an earlier export (${extra.join(", ")}); refusing to touch it`);
    for (const e of await readdir(out)) if (e !== ".git") await rm(path.join(out, e), { recursive: true, force: true });
  }
  const tmp = await mkdtemp(path.join(tmpdir(), "agentsol-pages-"));
  try {
    const build = path.join(tmp, "web");
    const r = spawnSync(process.execPath, [path.join(REPO, "scripts/buildWeb.ts"), "--out", build], { cwd: REPO, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`web build failed:\n${r.stderr.slice(-800)}`);
    await cp(path.join(build, "js"), path.join(out, "js"), { recursive: true });
    for (const f of ["styles.css", "favicon.svg"]) await copyFile(path.join(build, f), path.join(out, f));
    const html = await readFile(path.join(build, "index.html"), "utf8");
    const anchor = '<meta charset="utf-8">';
    if (!html.includes(anchor) || html.includes("Content-Security-Policy")) throw new Error("index.html head is not in the expected shape");
    await writeFile(path.join(out, "index.html"), html.replace(anchor, `${anchor}\n  <meta http-equiv="Content-Security-Policy" content="${PAGES_CSP}">`));
    await writeFile(path.join(out, ".nojekyll"), "");
    await writeFile(path.join(out, "README.md"), README);
    await copyFile(path.join(REPO, "LICENSE"), path.join(out, "LICENSE"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const problems = await auditOutput(out, [REPO, homedir(), await realpath(tmpdir())]);
  const all = (await readdir(out, { recursive: true })).map(String).filter((f) => !f.startsWith(".git"));
  for (const f of all) if (/\.(map|ts|tgz|zip|sqlite|db|env)$|^\.agentsol|build/.test(f)) problems.push(`unexpected file ${f}`);
  for (const f of all.filter((f) => !f.endsWith("/") && f !== "js")) {
    const p = path.join(out, f);
    if ((await readdir(path.dirname(p))).includes(path.basename(p)) && !(await import("node:fs")).statSync(p).isDirectory()) {
      const t = await readFile(p, "utf8");
      if (/[A-Za-z0-9._%+-]+@(?!media\b)[A-Za-z0-9-]+\.[a-z]{2,}/.test(t.replace(/@(media|import|keyframes|supports|font-face)\b/g, ""))) problems.push(`${f} contains an email-like string`);
      if (/dialogue/i.test(t)) problems.push(`${f} mentions a company name`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const outArg = i >= 0 ? process.argv[i + 1] : undefined;
  if (!outArg) throw new Error("usage: node scripts/exportPages.ts --out <dir>");
  const problems = await exportPages(path.resolve(outArg));
  if (problems.length) {
    process.stderr.write(`export failed the audit:\n  ${problems.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Exported GitHub Pages files to ${outArg}. Audit passed.\n`);
}
