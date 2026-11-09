import { request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAssistantService } from "../../src/core/service/assistant.ts";
import { fixture, sourceByPath, type Fixture } from "../helpers.ts";

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Raw HTTP so tests can send hostile Host/Origin headers that fetch() refuses to set. */
export function raw(port: number, opts: { method?: string; path?: string; headers?: Record<string, string> }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function tinyStatic(dir: string): Promise<string> {
  await mkdir(path.join(dir, "js"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(path.join(dir, "js", "app.js"), "export {};");
  return dir;
}

/** Synthetic project with one scanned source, one possible finding and one pending proposal. */
export async function seededFixture(files: Record<string, string> = { "AGENTS.md": "# Root\n- Use npm.\n", "web/AGENTS.md": "# Web\n- Use pnpm.\n" }, rationale = "Prefer pnpm"): Promise<Fixture> {
  const fx = await fixture(files);
  const svc = createAssistantService(fx.store, { reporter: () => "assistant:test", onInternalError: () => {} });
  const scan = await svc.scan({ projectId: fx.projectId });
  if (!scan.ok) throw new Error(scan.error.message);
  const { source, version } = sourceByPath(fx.store, fx.projectId, "AGENTS.md");
  const line2 = version.lines[1] ?? "";
  const p = svc.proposeChange({ projectId: fx.projectId, sourceId: source.id, baseVersionId: version.id, rationale, edits: [{ startLine: 2, endLine: 2, expectedText: line2, replacementLines: ["- Use pnpm."] }] });
  if (!p.ok) throw new Error(p.error.message);
  return fx;
}
