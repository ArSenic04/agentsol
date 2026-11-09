// Regression tests for defects found in the adversarial review (Nov 9, 2026).
import assert from "node:assert/strict";
import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { scanProject } from "../src/core/scan.ts";
import { redactLines } from "../src/core/secrets.ts";
import { submitSemanticFindings } from "../src/core/semantic.ts";
import { fixture, sourceByPath } from "./helpers.ts";

test("R1 PGP private key blocks are redacted (BEGIN PGP PRIVATE KEY BLOCK)", () => {
  const r = redactLines(["intro", "-----BEGIN PGP PRIVATE KEY BLOCK-----", "lQOYBFAKEFAKE", "-----END PGP PRIVATE KEY BLOCK-----", "after"]);
  assert.ok(!r.lines.join("\n").includes("lQOYBFAKEFAKE"));
  assert.equal(r.lines[4], "after");
});

test("R2 more common credential shapes are redacted", () => {
  const samples = [
    "DATABASE_URL=postgres://admin:FakePassw0rd@db.example.test:5432/app",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlZmFrZQ",
    "stripe sk_live_FAKEFAKEFAKEFAKEFAKE1234",
    "gitlab glpat-FAKEFAKEFAKEFAKEFAKE",
    "npm npm_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "hf hf_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "password: hunter22",
  ];
  for (const s of samples) {
    const r = redactLines([s]);
    assert.equal(r.redacted.length, 1, `not redacted: ${s}`);
  }
  assert.equal(redactLines(["Use a strong password for the demo."]).redacted.length, 0, "prose is not redacted");
});

test("R3 secret-like and non-instruction file names are not disclosed as exclusions", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n", "acme-merger-secret-plan.md": "x", ".env.production": "x", "keys/server.pem": "x" });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const listed = fx.store.listExclusions(fx.projectId).map((e) => e.relPath);
    assert.deepEqual(listed, [], `names leaked: ${listed.join(", ")}`);
  } finally {
    await fx.cleanup();
  }
});

test("R4 CLAUDE.local.md (personal, usually gitignored) is not read by default", async () => {
  const fx = await fixture({ "CLAUDE.md": "# Team\n", "CLAUDE.local.md": "# My private notes\n" });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    assert.deepEqual(fx.store.listSources(fx.projectId).map((s) => s.relPath), ["CLAUDE.md"]);
    assert.deepEqual(fx.store.listExclusions(fx.projectId), [{ relPath: "CLAUDE.local.md", reason: "personal_local_file" }]);
  } finally {
    await fx.cleanup();
  }
});

test("R5 a hard link to a file outside the project is not read", async () => {
  const fx = await fixture({ "README.md": "x" });
  try {
    const outside = path.join(path.dirname(fx.root), "outside-notes.md");
    await writeFile(outside, "outside content\n");
    await link(outside, path.join(fx.root, "AGENTS.md"));
    await scanProject(fx.store, fx.projectId, "test");
    assert.deepEqual(fx.store.listSources(fx.projectId), []);
    assert.deepEqual(fx.store.listExclusions(fx.projectId), [{ relPath: "AGENTS.md", reason: "hard_link" }]);
  } finally {
    await fx.cleanup();
  }
});

test("R6 a registered root later replaced by a symlink is refused at scan time", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n" });
  try {
    const elsewhere = path.join(path.dirname(fx.root), "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "AGENTS.md"), "# Not the registered project\n");
    await rename(fx.root, `${fx.root}-moved`);
    await symlink(elsewhere, fx.root);
    const r = await scanProject(fx.store, fx.projectId, "test");
    assert.equal(r.ok, false);
    assert.deepEqual(fx.store.listSources(fx.projectId), []);
  } finally {
    await fx.cleanup();
  }
});

test("R7 CLAUDE.md imports of secret-like names are not probed for existence", async () => {
  const fx = await fixture({ "CLAUDE.md": "@.env.production\n@config/credentials.json\n" });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const msgs = fx.store.listFindings(fx.projectId).filter((f) => f.checkId === "D09").map((f) => f.message);
    assert.equal(msgs.length, 2);
    assert.ok(msgs.every((m) => /secret-like name; not checked/.test(m)), msgs.join("\n"));
  } finally {
    await fx.cleanup();
  }
});

test("R8 assistant-written text that looks like a secret is rejected, not stored", async () => {
  const fx = await fixture({ "AGENTS.md": "# Root\n- Use npm.\n" });
  try {
    await scanProject(fx.store, fx.projectId, "test");
    const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
    const r = submitSemanticFindings(fx.store, {
      projectId: fx.projectId, reporter: "t",
      findings: [{ checkId: "S03", title: "t", message: "Use key sk-FAKEFAKEFAKEFAKEFAKEFAKE12345 instead", severity: "info", confidence: "low", evidence: [{ sourceId: source.id, versionId: version.id, startLine: 2, endLine: 2, quote: "- Use npm." }] }],
    });
    assert.equal(r.accepted.length, 0);
    assert.equal(fx.store.listFindings(fx.projectId, "semantic").length, 0);
  } finally {
    await fx.cleanup();
  }
});
