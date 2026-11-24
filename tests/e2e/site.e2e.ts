/**
 * Browser tests of the real built site with headless Chromium (playwright-core, using the
 * locally cached browser). Run with: npm run test:web. Not part of npm test because it
 * needs a browser binary.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

/** Collects page errors, CSP violations, any console error, external requests and API calls. */
async function openPage(opts: { width?: number; reducedMotion?: "reduce" | "no-preference"; clipboard?: boolean } = {}): Promise<{ page: Page; problems: string[]; apiRequests: string[] }> {
  const context = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: 900 }, reducedMotion: opts.reducedMotion ?? "no-preference" });
  if (opts.clipboard) await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  const problems: string[] = [];
  const apiRequests: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    problems.push(`console: ${t}`);
  });
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "127.0.0.1") problems.push(`external request: ${u.origin}`);
    if (u.pathname.startsWith("/api")) apiRequests.push(u.pathname);
  });
  return { page, problems, apiRequests };
}

test("landing explains the product honestly and the CTA opens the labelled demo", async () => {
  const { page, problems } = await openPage();
  await page.goto(staticSrv.url);
  await page.getByRole("heading", { level: 1 }).waitFor();
  assert.match(await page.getByRole("heading", { level: 1 }).innerText(), /Your AI agents forget\. Agentsol remembers\./);
  assert.ok(await page.getByText(/Free MCP server/).first().isVisible());
  await page.locator(".excerpt").waitFor();
  assert.match(await page.locator(".excerpt").innerText(), /prewritten by the demo script/);
  const text = await page.locator("main").innerText();
  for (const banned of [/testimonial/i, /trusted by/i, /\d[\d,]* (users|developers|teams)/i, /sign up/i, /waitlist/i, /forever free/i, /guarantee(?!s? )/i]) assert.ok(!banned.test(text), `no ${banned}`);
  assert.ok(await page.locator("form, input[type=email]").count() === 0, "no signup or contact forms on the landing page");
  assert.match(await page.locator("#learn").innerText(), /keep repeating/);
  assert.match(await page.locator("#guardsec").innerText(), /never run/);
  assert.match(text, /What repeated mistakes cost[\s\S]*1 wrong instruction[\s\S]*AGENTS\.md line 7\s+now {3}− - Run `npm test`[\s\S]*fix {3}\+ - Run `pnpm test`[\s\S]*npx -y agentsol@alpha learn --propose/);
  assert.match(text, /Instructions that cause it/);
  const tracks = page.locator(".client-carousel .client-track");
  assert.equal(await tracks.count(), 2, "the carousel loops one copy of the logos");
  assert.equal(await tracks.nth(1).getAttribute("aria-hidden"), "true", "screen readers hear each app once");
  assert.deepEqual(await tracks.nth(0).locator("li").allInnerTexts(), await tracks.nth(1).locator("li").allInnerTexts());
  assert.equal(await tracks.nth(0).locator("svg.client-mark").count(), 8);
  assert.notEqual(await page.locator(".client-belt").evaluate((el) => getComputedStyle(el).animationName), "none");
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
  assert.equal(await page.locator(".finding").count(), 8);
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

test("inspect: examples give a danger verdict, pasted safe text is clean, nothing leaves the tab", async () => {
  const { page, problems } = await openPage();
  await page.goto(`${staticSrv.url}#/inspect`);
  await page.locator("#page-title").waitFor();
  await page.getByRole("button", { name: "a poisoned MCP tool" }).click();
  await page.locator(".verdict-danger").waitFor();
  assert.match(await page.locator(".results").innerText(), /XML-style tag/);
  await page.getByRole("button", { name: "a skill that steals cloud keys" }).click();
  await page.locator(".verdict-danger").waitFor();
  assert.match(await page.locator(".results").innerText(), /credential files/);
  await page.locator("#inspect-text").fill("---\nname: notes\ndescription: Summarizes notes.\n---\n\nRead the notes and write a short summary.\n");
  await page.selectOption("#inspect-kind", "skill/SKILL.md");
  await page.getByRole("button", { name: "Inspect pasted text" }).click();
  await page.locator(".verdict-clean").waitFor();
  assert.deepEqual(problems, []);
  await page.context().close();
});

test("narrow mobile width has no horizontal overflow; reduced motion disables animation", async () => {
  const { page, problems } = await openPage({ width: 375, reducedMotion: "reduce" });
  for (const route of ["", "#/inspect", "#/check", "#/demo", "#/setup", "#/workspace"]) {
    await page.goto(`${staticSrv.url}${route}`);
    await page.locator("#page-title").waitFor();
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${route || "landing"} overflows by ${overflow}px`);
  }
  await page.goto(staticSrv.url);
  await page.locator(".hero-art .term").waitFor();
  const heroMotion = await page.evaluate(() => [...document.querySelectorAll(".term-line, .pulse")].map((el) => getComputedStyle(el).animationName));
  assert.ok(heroMotion.length > 0 && heroMotion.every((n) => n === "none"), `hero motion stops under reduced motion: ${heroMotion.join(",")}`);
  const anim = await page.evaluate(() => {
    const s = document.createElement("span");
    s.className = "spinner";
    document.body.appendChild(s);
    return getComputedStyle(s).animationName;
  });
  assert.equal(anim, "none");
  assert.equal(await page.locator(".client-belt").evaluate((el) => getComputedStyle(el).animationName), "none", "logos stop scrolling under reduced motion");
  assert.ok(await page.locator(".client-track[aria-hidden=true]").isHidden(), "the loop copy is hidden when nothing scrolls");
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

/**
 * Everything on the page must be reachable: nothing clipped by overflow hidden/clip, nothing
 * spilling past the viewport, and every sideways-scrolling block focusable (keyboard) and named.
 */
async function reachabilityProblems(page: Page, where: string): Promise<string[]> {
  // Let ResizeObserver callbacks run (they fire after layout, before the next paint).
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const describe = (el: Element): string => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    const scrollerOf = (el: Element): Element | null => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === "auto" || ox === "scroll") return a;
      }
      return null;
    };
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".sr-only")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        if (cs.overflowX === "hidden" || cs.overflowX === "clip") out.push(`clipped: ${describe(el)}`);
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") {
          if (!(el instanceof HTMLElement) || el.tabIndex < 0) out.push(`scrolls but not keyboard focusable: ${describe(el)}`);
          if (!el.getAttribute("aria-label")) out.push(`scroll region has no name: ${describe(el)}`);
        }
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1) && !scrollerOf(el)) out.push(`outside viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${window.innerWidth}): ${describe(el)}`);
    }
    for (const wrap of document.querySelectorAll(".code-wrap")) {
      const pre = wrap.querySelector("pre");
      const hint = wrap.querySelector(".scroll-hint");
      if (!pre || !(hint instanceof HTMLElement) || pre.clientWidth === 0) continue;
      const over = pre.scrollWidth > pre.clientWidth + 1;
      if (over === hint.hidden) out.push(`scroll hint ${over ? "missing on an overflowing" : "shown on a fitting"} block: ${describe(pre)}`);
    }
    for (const pre of document.querySelectorAll(".cmd-wrap")) if (pre.scrollWidth > pre.clientWidth + 1) out.push(`command block does not wrap: ${describe(pre)}`);
    return out;
  });
  return found.map((f) => `${where}: ${f}`);
}

/** Scrolls a block to its far edge and checks the end of its longest line becomes visible. */
async function farEdgeVisible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((pre) => {
    pre.scrollLeft = pre.scrollWidth;
    let longest: Text | null = null;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n instanceof Text && n.data.trim() && (!longest || n.data.length > longest.data.length)) longest = n;
    if (!longest) return false;
    const range = document.createRange();
    const end = longest.data.trimEnd().length;
    range.setStart(longest, end - 1);
    range.setEnd(longest, end);
    const box = range.getBoundingClientRect();
    const frame = pre.getBoundingClientRect();
    return box.right <= frame.right + 1 && box.left >= frame.left - 1;
  });
}

for (const width of [375, 390, 1440]) {
  test(`long code, diffs and commands are fully reachable at ${width}px`, async () => {
    const { page, problems, apiRequests } = await openPage({ width });
    const issues: string[] = [];
    await page.goto(staticSrv.url);
    await page.locator(".excerpt .diff").waitFor();
    issues.push(...(await reachabilityProblems(page, "landing")));
    assert.ok(await farEdgeVisible(page, ".excerpt .diff"), "landing diff: end of the longest line can be scrolled into view");

    await page.goto(`${staticSrv.url}#/demo`);
    await page.locator(".finding").first().click();
    await page.locator(".evidence").first().waitFor();
    issues.push(...(await reachabilityProblems(page, "demo findings")));
    await page.getByRole("tab", { name: /Files/ }).click();
    await page.locator(".file", { hasText: /^AGENTS\.md/ }).first().click();
    await page.locator("#panel-files .detail .code").waitFor();
    issues.push(...(await reachabilityProblems(page, "demo files")));
    await page.getByRole("tab", { name: /Proposed changes/ }).click();
    await page.locator(".proposal .diff").waitFor();
    issues.push(...(await reachabilityProblems(page, "demo changes")));
    assert.ok(await farEdgeVisible(page, ".proposal .diff"), "demo diff: end of the longest line can be scrolled into view");
    if (width < 400) assert.ok(await page.locator(".proposal .code-wrap:has(.diff) .scroll-hint").isVisible(), "narrow screens say the diff scrolls sideways");
    const diff = page.locator(".proposal .diff");
    if (await diff.evaluate((el) => el.scrollWidth > el.clientWidth)) {
      await diff.evaluate((el) => { el.scrollLeft = 0; });
      await diff.focus();
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("diff")), true, "diff takes focus");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => (document.querySelector(".proposal .diff")?.scrollLeft ?? 0) > 0, undefined, { timeout: 2000 }).catch(() => undefined);
      assert.ok((await diff.evaluate((el) => el.scrollLeft)) > 0, "focused diff scrolls with the arrow keys");
    }
    await page.getByRole("tab", { name: /Load order/ }).click();
    await page.locator(".chain li").first().waitFor();
    issues.push(...(await reachabilityProblems(page, "demo load order")));

    await page.goto(`${staticSrv.url}#/setup`);
    await page.locator(".cmd-code").first().waitFor();
    issues.push(...(await reachabilityProblems(page, "setup")));
    assert.ok(await farEdgeVisible(page, ".cmd-code:not(.cmd-wrap)"), "setup config: end of the longest line can be scrolled into view");
    await page.goto(`${staticSrv.url}#/workspace`);
    await page.getByText("No local workspace connected").waitFor();
    issues.push(...(await reachabilityProblems(page, "workspace (static)")));
    assert.deepEqual(issues, []);
    assert.deepEqual(apiRequests, [], "a static copy never calls the API");
    assert.deepEqual(problems, []);
    await page.context().close();
  });
}

test("commands wrap visually but copy and select as the exact original bytes", async () => {
  const { page, problems } = await openPage({ width: 375, clipboard: true });
  await page.goto(`${staticSrv.url}#/setup`);
  const step5 = page.locator(".setup-step").nth(6);
  const pre = step5.locator(".cmd-code");
  const expected = ["review", "approve", "apply"].map((v) => `npx -y agentsol@alpha ${v} <proposalId>`).join("\n");
  assert.ok((await pre.evaluate((el) => el.getBoundingClientRect().height)) > 3 * 30, "long commands really wrap at 375px");
  await step5.getByRole("button", { name: "Copy" }).click();
  await step5.getByText("Copied").waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  const selected = await pre.evaluate((el) => {
    const sel = window.getSelection();
    if (!sel) return "";
    sel.selectAllChildren(el);
    return sel.toString();
  });
  assert.equal(selected.replace(/\n$/, ""), expected, "selecting the block gives the same text, no inserted line breaks");
  assert.deepEqual(problems, []);
  await page.context().close();
});

test("local bridge: very long instruction lines stay reachable on mobile", async () => {
  const long = `- ${"Always run the full integration suite with every service started, ".repeat(5)}END_OF_LINE`;
  const fx = await seededFixture({ "AGENTS.md": `# Root\n${long}\n- Use npm.\n`, "web/AGENTS.md": "# Web\n" });
  const local = await startWebServer({ store: fx.store, staticDir: DIST, port: 0, onInternalError: () => {} });
  try {
    for (const width of [375, 1440]) {
      const { page, problems, apiRequests } = await openPage({ width });
      await page.goto(`${local.url}#/workspace`);
      await page.getByText("Your local workspace, read-only.").waitFor();
      const issues = await reachabilityProblems(page, `local ${width}`);
      await page.getByRole("tab", { name: /Files/ }).click();
      await page.locator(".file", { hasText: /^AGENTS\.md/ }).first().click();
      await page.locator("#panel-files .detail .code").waitFor();
      issues.push(...(await reachabilityProblems(page, `local files ${width}`)));
      assert.ok(await farEdgeVisible(page, "#panel-files .detail .code"), "END_OF_LINE can be scrolled into view");
      await page.getByRole("tab", { name: /Proposed changes/ }).click();
      issues.push(...(await reachabilityProblems(page, `local changes ${width}`)));
      assert.deepEqual(issues, []);
      assert.ok(apiRequests.includes("/api/health"), "the bridge is still verified before showing data");
      assert.deepEqual(problems, []);
      await page.context().close();
    }
  } finally {
    await local.close();
    await fx.cleanup();
  }
});

test("hero session: decorative, labelled for screen readers, honest about support, plays once", async () => {
  const { page, problems } = await openPage({ width: 1440 });
  await page.goto(staticSrv.url);
  const art = page.locator(".hero-art");
  await art.locator(".term").waitFor();
  assert.equal(await art.locator(".term").getAttribute("aria-hidden"), "true");
  assert.equal(await art.locator(".term [tabindex], .term a, .term button").count(), 0, "the session adds no focus stops");
  const caption = await art.locator("figcaption").innerText();
  assert.match(caption, /Illustrative session/);
  assert.match(caption, /real hook output/);
  assert.match(caption, /not yet run live/);
  assert.match(await art.locator(".sr-only").textContent() ?? "", /waits for you to approve/);
  const motion = await page.evaluate(() => [...document.querySelectorAll(".term-line")].map((el) => getComputedStyle(el).animationIterationCount));
  assert.ok(motion.length >= 9 && motion.every((n) => n === "1"), `session lines animate once (${motion.join(",")})`);
  const brand = await page.locator(".wordmark").innerText();
  assert.equal(brand.trim(), "Agentsol");
  assert.equal(await page.title(), "Agentsol: your AI agents forget, Agentsol remembers");
  const text = await page.locator("body").innerText();
  assert.ok(!/AgentWeave|Agentlore/i.test(text), "no old brand on the landing page");
  assert.equal(await page.locator(".wordmark svg").getAttribute("aria-hidden"), "true", "the logo is decorative next to the visible name");
  await page.goto(`${staticSrv.url}#/setup`);
  await page.locator(".cmd-code").first().waitFor();
  const setupText = await page.locator("main").innerText();
  assert.match(setupText, /npx -y agentsol@alpha start/);
  assert.match(setupText, /When an AI agent runs it, it connects nothing/);
  assert.ok(!/Agentlore|AGENTLORE|agentlore-demo|not published yet/i.test(setupText), "setup reflects the published Agentsol alpha");
  assert.equal(await page.locator('main a[href="https://www.npmjs.com/package/agentsol"]').getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual(problems, []);
  await page.context().close();
});

test("browser checker runs the checks locally, masks secrets and builds a prompt for any AI", async () => {
  const token = randomBytes(12).toString("hex");
  const { page, problems, apiRequests } = await openPage({ clipboard: true });
  await page.goto(`${staticSrv.url}#/check`);
  await page.locator("#page-title").waitFor();
  await page.locator("#pick-files").setInputFiles([
    { name: "CLAUDE.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n\n@AGENTS.md\n@.env.local\n- Always run the unit tests before you commit.\n") },
    { name: "AGENTS.md", mimeType: "text/markdown", buffer: Buffer.from(`# Synthetic\n\n- Always run the unit tests before you commit.\n- token: ${token}\n`) },
  ]);
  await page.locator("#results-title").waitFor();
  const text = await page.locator(".results").innerText();
  assert.match(text, /D12/);
  assert.match(text, /D09/);
  assert.match(text, /D10/);
  assert.match(text, /D08/);
  assert.match(text, /REDACTED:assignment/);
  assert.ok(!text.includes(token), "secret-like value never shown");
  const prompt = page.locator(".handoff-box");
  await prompt.getByRole("button", { name: "Copy" }).click();
  await prompt.getByText("Copied").waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /POSSIBLE issues/);
  assert.match(copied, /### AGENTS\.md/);
  assert.ok(!copied.includes(token));

  await page.locator("#paste-name").selectOption("SKILL.md");
  await page.locator("#paste-text").fill("---\nname: Release-Notes\n---\nBody.\n");
  await page.getByRole("button", { name: "Check pasted text" }).click();
  await page.locator(".results", { hasText: "D03" }).waitFor();
  assert.match(await page.locator(".results").innerText(), /D02[\s\S]*lowercase/);
  assert.deepEqual(apiRequests, []);
  assert.deepEqual(problems, []);
  await page.context().close();
});
