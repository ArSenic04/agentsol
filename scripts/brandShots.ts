/** Local-only: renders the logo contact sheet and site screenshots into artifacts/screens/ from the running previews. */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "artifacts", "screens");
const svg = (f: string) => readFileSync(path.join(REPO, "brand", f), "utf8");
const uri = (f: string) => `data:image/svg+xml;base64,${Buffer.from(svg(f)).toString("base64")}`;
const sizes = [16, 32, 48, 128];
const sheet = `<!doctype html><html><body style="margin:0;font-family:ui-sans-serif,system-ui;background:#f5f2ea;color:#1c1b18">
<div style="padding:48px 56px;width:1088px">
 <div style="font:600 13px ui-sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#9a3412">Agentsol · logo</div>
 <div style="display:flex;gap:40px;margin-top:24px">
  <div style="flex:1;background:#fbf9f4;border:1px solid #d6cfbf;border-radius:14px;padding:44px;display:flex;align-items:center;justify-content:center"><img src="${uri("agentsol-wordmark.svg")}" style="height:84px"></div>
  <div style="flex:1;background:#14130f;border-radius:14px;padding:44px;display:flex;align-items:center;justify-content:center"><img src="${uri("agentsol-wordmark-dark.svg")}" style="height:84px"></div>
 </div>
 <div style="display:flex;gap:40px;margin-top:40px;align-items:flex-end">
  <div><img src="${uri("agentsol-mark.svg")}" style="width:160px"><div style="font-size:13px;margin-top:8px">Mark</div></div>
  <div><img src="${uri("agentsol-mark-tile.svg")}" style="width:160px"><div style="font-size:13px;margin-top:8px">App icon / favicon</div></div>
  <div style="flex:1"></div>
  <div><div style="display:flex;gap:22px;align-items:flex-end">${sizes.map((s) => `<div style="text-align:center"><img src="${uri("agentsol-mark-tile.svg")}" width="${s}" height="${s}" style="image-rendering:auto"><div style="font-size:12px;margin-top:6px">${s}px</div></div>`).join("")}</div>
  <div style="display:flex;gap:22px;align-items:flex-end;margin-top:18px">${sizes.map((s) => `<div style="text-align:center"><img src="${uri("agentsol-mark.svg")}" width="${s}" height="${s}"></div>`).join("")}</div></div>
 </div>
 <div style="margin-top:36px;font-size:14px;color:#4a463d">A half sun rising on a horizon, with one long ray as the guiding direction. Ink #1c1b18 · cream #f5f2ea · terracotta #d4612c.</div>
</div></body></html>`;

const browser = await chromium.launch({ headless: true });
const p1 = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 });
await p1.setContent(sheet);
await p1.waitForLoadState("networkidle");
await p1.screenshot({ path: path.join(OUT, "agentsol-logo-sheet.png"), fullPage: true });
const shots: [string, string, number, number][] = [
  ["hero-desktop.png", "", 1440, 900], ["hero-mobile.png", "", 390, 844], ["setup-desktop.png", "#/setup", 1440, 1400], ["setup-mobile.png", "#/setup", 390, 844],
];
for (const [file, route, w, hgt] of shots) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const pg = await ctx.newPage();
  await pg.goto(`http://127.0.0.1:4318/${route}`);
  await pg.waitForSelector(route ? ".cmd-code" : ".hero-art svg");
  await pg.screenshot({ path: path.join(OUT, file) });
  await ctx.close();
}
await browser.close();
process.stdout.write(`wrote ${OUT}\n`);
