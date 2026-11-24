/**
 * The GitHub Pages export, served the way Pages serves a project site: under /agentsol/,
 * plain static files, and NO security headers (only the <meta> CSP inside index.html).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { exportPages } from "../../scripts/exportPages.ts";

const BASE = "/agentsol/";
const TYPES: Record<string, string> = { ".png": "image/png", ".txt": "text/plain", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".md": "text/markdown" };
let browser: Browser;
let server: Server;
let origin = "";
let dir = "";

before(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), "agentsol-pages-test-")), "site");
  assert.deepEqual(await exportPages(dir), []);
  server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (!u.pathname.startsWith(BASE)) { res.writeHead(404).end(); return; }
    const rel = u.pathname.slice(BASE.length) || "index.html";
    try {
      const body = await readFile(path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, "")));
      res.writeHead(200, { "Content-Type": TYPES[path.extname(rel)] ?? "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
  server.close();
  await rm(path.dirname(dir), { recursive: true, force: true });
});

for (const width of [375, 390, 1280]) {
  test(`pages export at ${BASE} (${width}px): all routes render, assets load, no errors, no requests outside the site`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
    page.on("requestfailed", (r) => problems.push(`failed: ${r.url()}`));
    page.on("response", (r) => { if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`); });
    page.on("request", (r) => { const u = new URL(r.url()); if (u.origin !== origin || !u.pathname.startsWith(BASE)) problems.push(`outside request: ${r.url()}`); });
    await page.goto(`${origin}${BASE}`);
    await page.locator(".hero-art .term").waitFor();
    assert.equal((await page.locator(".wordmark").innerText()).trim(), "Agentsol");
    assert.ok(await page.locator(".wordmark svg .mark-core").count() === 1, "logo mark rendered");
    assert.ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)"), "stylesheet applied");
    await page.goto(`${origin}${BASE}#/demo`);
    await page.locator(".finding").first().waitFor();
    await page.goto(`${origin}${BASE}#/check`);
    await page.locator(".drop").waitFor();
    await page.goto(`${origin}${BASE}#/workspace`);
    await page.getByText("No local workspace connected").waitFor();
    await page.goto(`${origin}${BASE}#/setup`);
    await page.locator(".cmd-code").first().waitFor();
    assert.match(await page.locator("main").innerText(), /npx -y agentsol@alpha start/);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    assert.match(csp ?? "", /connect-src 'none'/);
    const blocked = await page.evaluate(async () => { try { await fetch("/api/health"); return "allowed"; } catch { return "blocked"; } });
    assert.equal(blocked, "blocked", "the meta CSP blocks any fetch");
    problems.splice(0, problems.length, ...problems.filter((p) => !/Content Security Policy|api\/health/.test(p)));
    assert.deepEqual(problems, []);
    await ctx.close();
  });
}

test("pages export copy button copies the exact command", async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  await page.goto(`${origin}${BASE}#/setup`);
  const step1 = page.locator(".setup-step").first();
  await step1.getByRole("button", { name: "Copy" }).click();
  await step1.getByText("Copied").waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "npm i -g agentsol@alpha\ncd your-project\nagentsol start");
  await ctx.close();
});
