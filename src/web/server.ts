/**
 * Local loopback bridge: serves the built website and the read-only API for ONE
 * explicitly named workspace. Binds 127.0.0.1 only. GET/HEAD only. Host and Origin are
 * checked (DNS-rebinding and cross-site defence). No CORS. API responses are no-store.
 * Must never import humanApproval.ts or service/operator.ts (a test walks the graph).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createAssistantService, type AssistantService } from "../core/service/assistant.ts";
import type { WorkspaceStore } from "../core/store.ts";
import { handleApi, type ApiResponse } from "./api.ts";

export const LOOPBACK = "127.0.0.1";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon",
};

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
};

type StaticFile = { body: Buffer; type: string };

/** Snapshot of regular files under dir (symlinks are skipped). URL paths map only to these. */
export function loadStaticManifest(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) {
        const type = CONTENT_TYPES[path.extname(name)];
        if (type) files.set(`/${childRel}`, { body: readFileSync(childAbs), type });
      }
    }
  };
  walk(dir, "");
  const index = files.get("/index.html");
  if (index) files.set("/", index);
  return files;
}

export type WebServerOptions = {
  /** null = static demo only (no API): the same shape a static host would serve. */
  store: WorkspaceStore | null;
  staticDir: string;
  port: number;
  onInternalError?: (operation: string, error: unknown) => void;
};

export type RunningServer = { server: Server; port: number; url: string; close: () => Promise<void> };

const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, head: boolean, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": String(Buffer.byteLength(body)), ...extra });
  res.end(head ? undefined : body);
}

const jsonError = (code: string, message: string): string => JSON.stringify({ error: { code, message } });

export function startWebServer(opts: WebServerOptions): Promise<RunningServer> {
  const files = loadStaticManifest(opts.staticDir);
  const sink = opts.onInternalError ?? ((op: string, e: unknown) => process.stderr.write(`agentweave-web: ${op} internal error: ${e instanceof Error ? e.message : String(e)}\n`));
  const svc: AssistantService | null = opts.store ? createAssistantService(opts.store, { reporter: () => "web-local:read-only", onInternalError: sink }) : null;
  let port = opts.port;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return send(res, 405, JSON_TYPE, jsonError("method_not_allowed", "This server is read-only"), false, { Allow: "GET, HEAD" });
    const allowedHosts = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`]);
    if (!req.headers.host || !allowedHosts.has(req.headers.host)) return send(res, 421, TEXT_TYPE, "Wrong host\n", head);
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${LOOPBACK}:${port}` && origin !== `http://localhost:${port}`) {
      return send(res, 403, JSON_TYPE, jsonError("forbidden", "Cross-origin requests are not allowed"), head);
    }
    const rawUrl = req.url ?? "/";
    if (rawUrl.length > 2048 || !rawUrl.startsWith("/")) return send(res, 400, TEXT_TYPE, "Bad request\n", head);
    const url = new URL(rawUrl, `http://${LOOPBACK}:${port}`);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const site = req.headers["sec-fetch-site"];
      const apiHeaders = { "Cache-Control": "no-store, private", Vary: "Origin" };
      if (site !== undefined && site !== "same-origin" && site !== "none") return send(res, 403, JSON_TYPE, jsonError("forbidden", "Cross-site requests are not allowed"), head, apiHeaders);
      if (!svc) return send(res, 404, JSON_TYPE, jsonError("not_found", "This is the static demo; no local workspace is connected"), head, apiHeaders);
      const segments = url.pathname.slice("/api/".length).split("/").filter((s) => s.length > 0);
      let out: ApiResponse;
      try {
        out = await handleApi(svc, segments, url.searchParams);
      } catch (e) {
        sink("web_api", e);
        out = { status: 500, body: { error: { code: "internal_error", message: "Unexpected error; details are in the local server log" } } };
      }
      return send(res, out.status, JSON_TYPE, JSON.stringify(out.body), head, apiHeaders);
    }
    const file = files.get(url.pathname);
    if (!file) return send(res, 404, TEXT_TYPE, "Not found\n", head, { "Cache-Control": "no-store" });
    return send(res, 200, file.type, file.body, head, { "Cache-Control": "no-cache" });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      sink("web_request", e);
      if (!res.headersSent) send(res, 500, TEXT_TYPE, "Internal error\n", false);
      else res.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, LOOPBACK, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("unexpected listen address"));
        return;
      }
      port = addr.port;
      resolve({
        server,
        port,
        url: `http://${LOOPBACK}:${port}/`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
