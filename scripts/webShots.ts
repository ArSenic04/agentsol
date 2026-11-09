/**
 * Local visual check: screenshots of the built site at desktop and mobile widths.
 * Usage: node scripts/webShots.ts <staticBaseUrl> <outDir> [localBridgeUrl]
 */
import { chromium } from "playwright-core";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4318/";
const localUrl = process.argv[4];
const out = path.resolve(process.argv[3] ?? "artifacts/screenshots");
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${label}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    await page.goto(base);
    await page.waitForSelector(".excerpt");
    await page.screenshot({ path: path.join(out, `landing-${label}.png`), fullPage: true });
    await page.goto(`${base}#/demo`);
    await page.waitForSelector(".finding");
    await page.locator(".finding").first().click();
    await page.waitForSelector(".evidence");
    await page.screenshot({ path: path.join(out, `demo-findings-${label}.png`), fullPage: true });
    await page.getByRole("tab", { name: /Proposed changes/ }).click();
    await page.screenshot({ path: path.join(out, `demo-changes-${label}.png`), fullPage: true });
    if (label === "mobile") {
      // Close-ups of the long-line areas, at 2x, for checking readability.
      const zoom = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      await zoom.goto(base);
      await zoom.waitForSelector(".excerpt .diff");
      await zoom.locator(".excerpt-diff").screenshot({ path: path.join(out, "closeup-landing-diff-mobile.png") });
      await zoom.goto(`${base}#/demo`);
      await zoom.waitForSelector(".finding");
      await zoom.getByRole("tab", { name: /Proposed changes/ }).click();
      await zoom.locator(".proposal").screenshot({ path: path.join(out, "closeup-demo-change-mobile.png") });
      await zoom.goto(`${base}#/setup`);
      await zoom.waitForSelector(".setup-step");
      await zoom.locator(".setup-step").nth(4).screenshot({ path: path.join(out, "closeup-setup-commands-mobile.png") });
      await zoom.locator(".setup-step").nth(6).screenshot({ path: path.join(out, "closeup-setup-config-mobile.png") });
      await zoom.close();
    }
    await page.goto(`${base}#/workspace`);
    await page.waitForSelector("text=No local workspace connected");
    await page.screenshot({ path: path.join(out, `workspace-none-${label}.png`), fullPage: false });
    await page.goto(`${base}#/setup`);
    await page.waitForSelector("#page-title");
    await page.screenshot({ path: path.join(out, `setup-${label}.png`), fullPage: true });
    if (localUrl) {
      await page.goto(`${localUrl}#/workspace`);
      await page.waitForSelector(".finding");
      await page.locator(".finding").first().click();
      await page.waitForSelector(".evidence");
      await page.screenshot({ path: path.join(out, `local-workspace-${label}.png`), fullPage: true });
      await page.getByRole("tab", { name: /Proposed changes/ }).click();
      await page.screenshot({ path: path.join(out, `local-changes-${label}.png`), fullPage: true });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
