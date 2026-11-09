import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { normalizeRelPath, resolveExistingInsideRoot } from "../src/core/paths.ts";
import { tempDir } from "./helpers.ts";

test("normalizeRelPath rejects traversal, absolute, NUL, backslash and empty paths", () => {
  const cases: [string, string][] = [
    ["../x", "traversal"],
    ["a/../../x", "traversal"],
    ["a/..", "traversal"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows", "absolute"],
    ["a\\b", "backslash"],
    ["a\0b", "nul_byte"],
    ["", "empty"],
    [".", "empty"],
  ];
  for (const [input, code] of cases) {
    const r = normalizeRelPath(input);
    assert.equal(r.ok, false, input);
    if (!r.ok) assert.equal(r.error.code, code, input);
  }
  const good = normalizeRelPath("./a//b/./c.md");
  assert.deepEqual(good, { ok: true, value: "a/b/c.md" });
});

test("resolveExistingInsideRoot never follows symlinks, inside or escaping the root", async () => {
  const base = await tempDir("paths");
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "dir"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "dir", "AGENTS.md"), "ok");
  await writeFile(path.join(outside, "AGENTS.md"), "outside");
  await symlink(path.join(outside, "AGENTS.md"), path.join(root, "escape.md"));
  await symlink(outside, path.join(root, "escapedir"));
  await symlink(path.join(root, "dir", "AGENTS.md"), path.join(root, "inside-link.md"));

  assert.deepEqual(await resolveExistingInsideRoot(root, "dir/AGENTS.md"), { ok: true, value: path.join(root, "dir", "AGENTS.md") });
  for (const rel of ["escape.md", "escapedir/AGENTS.md", "inside-link.md"]) {
    const r = await resolveExistingInsideRoot(root, rel);
    assert.equal(r.ok, false, rel);
    if (!r.ok) assert.equal(r.error.code, "symlink", rel);
  }
  const missing = await resolveExistingInsideRoot(root, "nope.md");
  assert.equal(missing.ok, false);
  const escape = await resolveExistingInsideRoot(root, "../outside/AGENTS.md");
  assert.equal(escape.ok, false);
  if (!escape.ok) assert.equal(escape.error.code, "traversal");
});
