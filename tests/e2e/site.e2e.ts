/**
 * Browser tests of the real built site with headless Chromium (playwright-core, using the
 * locally cached browser). Run with: npm run test:web. Not part of npm test because it
 * needs a browser binary.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { WorkspaceStore } from "../../src/core/store.ts";
import { startWebServer, type RunningServer } from "../../src/web/server.ts";
import { tempDir } from "../helpers.ts";
import { seededFixture } from "../web/helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.join(REPO, "dist", "web");
let browser: Browser;
let staticSrv: RunningServer;

before(async () => {
  browser = await chromium.launch({ headless: true });
  staticSrv = await startWebServer({ store: null, staticDir: DIST, port: 0 });
});
after(async () => {
  await staticSrv.close();
  await browser.close();
});

/** Fails on page errors, CSP violations and console errors other than the expected static-mode /api/health 404. */
async function openPage(opts: { width?: number; reducedMotion?: "reduce" | "no-preference" } = {}): Promise<{ page: Page; problems: string[] }> {
  const context = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: 900 }, reducedMotion: opts.reducedMotion ?? "no-preference" });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/404 \(Not Found\)/.test(t)) return;
    problems.push(`console: ${t}`);
  });
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "127.0.0.1") problems.push(`external request: ${u.origin}`);
  });
  return { page, problems };
}

test("landing explains the product honestly and the CTA opens the labelled demo", async () => {
  const { page, problems } = await openPage();
  await page.goto(staticSrv.url);
  await page.getByRole("heading", { level: 1 }).waitFor();
  assert.match(await page.getByRole("heading", { level: 1 }).innerText(), /Read them together/);
  assert.ok(await page.getByText("Early local prototype").first().isVisible());
  await page.locator(".excerpt").waitFor();
  assert.match(await page.locator(".excerpt").innerText(), /prewritten by the demo script/);
  const text = await page.locator("main").innerText();
  for (const banned of [/testimonial/i, /trusted by/i, /\d[\d,]* (users|developers|teams)/i, /sign up/i, /waitlist/i, /forever free/i, /guarantee(?!s? )/i]) assert.ok(!banned.test(text), `no ${banned}`);
  assert.ok(await page.locator("form, input[type=email]").count() === 0, "no signup or contact forms on the landing page");
  await page.getByRole("link", { name: "Open the interactive demo" }).first().click();
  await page.waitForURL(/#\/demo$/);
  await page.getByText("Synthetic demo.").waitFor();
  assert.deepEqual(problems, []);
  await page.context().close();
});

test("demo: findings with evidence, redacted files, diff and terminal handoff; no approve buttons", async () => {
  const { page, problems } = await openPage();
  await page.goto(`${staticSrv.url}#/demo`);
  await page.locator(".finding").first().waitFor();
  assert.equal(await page.locator(".finding").count(), 9);
  assert.equal(await page.getByRole("tab", { name: /Findings/ }).getAttribute("aria-selected"), "true");
  await page.locator(".finding", { hasText: "docs/style-guide.md" }).click();
  await page.locator(".evidence .cited").first().waitFor();
  assert.match(await page.locator(".evidence .cited").first().innerText(), /@docs\/style-guide\.md/);
  await page.locator(".finding", { hasText: "Possible contradiction" }).click();
  await page.locator(".detail", { hasText: "prewritten by the demo script" }).waitFor();
  assert.equal(await page.locator(".detail .evidence").count(), 2, "both quoted files are shown");

  await page.getByRole("tab", { name: /Files/ }).click();
  await page.locator(".file", { hasText: /^AGENTS\.md/ }).first().click();
  await page.locator("#panel-files .detail .code").waitFor();
  const fileText = await page.locator("#panel-files .detail .code").innerText();
  assert.match(fileText, /\[REDACTED:api_key\]/);
  assert.ok(!/sk-DEMO/.test(await page.content()), "the fake key never reaches the page");
  assert.match(await page.locator(".notread").innerText(), /CLAUDE\.local\.md/);

  await page.getByRole("tab", { name: /Proposed changes/ }).click();
  assert.match(await page.locator(".diff").innerText(), /\+- Use npm to run scripts \(services\/api uses pnpm\)\./);
  assert.match(await page.locator(".handoff").innerText(), /review chg_[0-9a-f]{16}/);
  assert.equal(await page.getByRole("button", { name: /approve|apply|reject/i }).count(), 0, "no approval buttons anywhere");

  await page.getByRole("tab", { name: /Load order/ }).click();
  await page.locator(".chain li").first().waitFor();
  assert.match(await page.locator(".scope-out .note").innerText(), /Modeled, not observed/);
  await page.selectOption("#scope-platform", "codex");
  await page.locator(".scope-out .chain li", { hasText: "AGENTS.md" }).first().waitFor();
  assert.deepEqual(problems, []);
  await page.context().close();
});

test("keyboard: skip link, arrow keys between tabs, visible focus", async () => {
  const { page, problems } = await openPage();
  await page.goto(`${staticSrv.url}#/demo`);
  await page.locator(".finding").first().waitFor();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to content");
  await page.getByRole("tab", { name: /Findings/ }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: /Files/ }).getAttribute("aria-selected"), "true");
  assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /Files/);
  await page.keyboard.press("End");
  assert.equal(await page.getByRole("tab", { name: /Load order/ }).getAttribute("aria-selected"), "true");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement ?? document.body).outlineStyle);
  assert.notEqual(outline, "none", "focused tab has a visible outline");
  assert.deepEqual(problems, []);
  await page.context().close();
});

test("narrow mobile width has no horizontal overflow; reduced motion disables animation", async () => {
  const { page, problems } = await openPage({ width: 375, reducedMotion: "reduce" });
  for (const route of ["", "#/demo", "#/setup", "#/workspace"]) {
    await page.goto(`${staticSrv.url}${route}`);
    await page.locator("#page-title").waitFor();
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${route || "landing"} overflows by ${overflow}px`);
  }
  const anim = await page.evaluate(() => {
    const s = document.createElement("span");
    s.className = "spinner";
    document.body.appendChild(s);
    return getComputedStyle(s).animationName;
  });
  assert.equal(anim, "none");
  assert.deepEqual(problems, []);
  await page.context().close();
});

test("workspace view: honest empty state without a bridge; live read-only data with one", async () => {
  const none = await openPage();
  await none.page.goto(`${staticSrv.url}#/workspace`);
  await none.page.getByText("No local workspace connected").waitFor();
  assert.match(await none.page.locator("main").innerText(), /npm run web:local -- --workspace/);
  await none.page.context().close();

  const fx = await seededFixture({ "AGENTS.md": "# Root\n- Use npm.\n<img src=x onerror=\"window.__xss=1\">\n", "web/AGENTS.md": "# Web\n" }, "<script>window.__xss=2</script><img src=x onerror=\"window.__xss=3\">");
  const local = await startWebServer({ store: fx.store, staticDir: DIST, port: 0, onInternalError: () => {} });
  try {
    const { page, problems } = await openPage();
    await page.goto(`${local.url}#/workspace`);
    await page.getByText("Your local workspace, read-only.").waitFor();
    await page.locator(".finding, .state-empty").first().waitFor();
    await page.getByRole("tab", { name: /Proposed changes/ }).click();
    assert.match(await page.locator(".proposal").innerText(), /<script>window.__xss=2<\/script>/, "rationale shown as text");
    await page.getByRole("tab", { name: /Files/ }).click();
    await page.locator(".file", { hasText: /^AGENTS\.md/ }).first().click();
    await page.locator("#panel-files .detail .code").waitFor();
    assert.match(await page.locator("#panel-files .detail .code").innerText(), /<img src=x onerror/);
    assert.equal(await page.locator("main img, main script").count(), 0, "instruction text never becomes markup");
    assert.equal(await page.evaluate(() => Reflect.get(window, "__xss")), undefined);
    assert.ok(!(await page.content()).includes(fx.root), "no absolute project path in the page");

    // Freshness: the project folder disappears; the page must say unknown, not clean.
    await rm(fx.root, { recursive: true, force: true });
    await page.reload();
    await page.getByText(/Disk state unknown/).waitFor();
    assert.deepEqual(problems, []);
    await page.context().close();
  } finally {
    await local.close();
    await fx.cleanup();
  }
});

test("workspace view: empty workspace and server error states", async () => {
  const base = await tempDir("e2e-empty");
  const store = WorkspaceStore.open(path.join(base, "ws"));
  const srv = await startWebServer({ store, staticDir: DIST, port: 0, onInternalError: () => {} });
  try {
    const { page } = await openPage();
    await page.goto(`${srv.url}#/workspace`);
    await page.getByText("No projects registered in this workspace yet").waitFor();
    store.close();
    await page.reload();
    await page.getByText("Could not load the workspace").waitFor();
    assert.ok(await page.getByRole("button", { name: "Try again" }).isVisible());
    assert.ok(!(await page.locator("main").innerText()).includes(base), "error text has no paths");
    await page.context().close();
  } finally {
    await srv.close();
    await rm(base, { recursive: true, force: true });
  }
});
