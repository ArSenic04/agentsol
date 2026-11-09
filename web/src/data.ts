/**
 * One interface for both modes. "demo" answers from responses the real core recorded
 * at build time on a synthetic project; "local" asks the loopback bridge. Both return
 * the same shapes, so every view is shared.
 */
export type ApiOk<T> = { ok: true; value: T };
export type ApiErr = { ok: false; status: number; code: string; message: string };
export type ApiResult<T> = ApiOk<T> | ApiErr;

export type Mode = "demo" | "local";
export interface DataSource {
  readonly mode: Mode;
  get<T>(path: string): Promise<ApiResult<T>>;
}

type Recorded = { status: number; body: unknown };
export type DemoBundle = { builtAt: string; responses: Record<string, Recorded>; scopeTargets: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toResult<T>(status: number, body: unknown): ApiResult<T> {
  if (status >= 200 && status < 300) {
    // Trust boundary: these bodies come from Agentlore's own API contract (see contract.ts).
    return { ok: true, value: body as T };
  }
  const err = isRecord(body) && isRecord(body["error"]) ? body["error"] : {};
  const code = typeof err["code"] === "string" ? err["code"] : "error";
  const message = typeof err["message"] === "string" ? err["message"] : `Request failed (${status})`;
  return { ok: false, status, code, message };
}

let demoBundle: Promise<DemoBundle | null> | null = null;
/** Loads the recorded demo once. Returns null if this build has no demo data. */
export function loadDemoBundle(): Promise<DemoBundle | null> {
  demoBundle ??= (async () => {
    try {
      const spec = "./demo-data.js";
      const mod: unknown = await import(spec);
      if (!isRecord(mod) || !isRecord(mod["default"])) return null;
      const d = mod["default"];
      if (typeof d["builtAt"] !== "string" || !isRecord(d["responses"]) || !Array.isArray(d["scopeTargets"])) return null;
      const responses: Record<string, Recorded> = {};
      for (const [k, v] of Object.entries(d["responses"])) {
        if (isRecord(v) && typeof v["status"] === "number") responses[k] = { status: v["status"], body: v["body"] };
      }
      return { builtAt: d["builtAt"], responses, scopeTargets: d["scopeTargets"].filter((x): x is string => typeof x === "string") };
    } catch {
      return null;
    }
  })();
  return demoBundle;
}

export function demoSource(bundle: DemoBundle): DataSource {
  return {
    mode: "demo",
    async get<T>(path: string): Promise<ApiResult<T>> {
      const r = bundle.responses[path];
      if (!r) return { ok: false, status: 404, code: "not_in_demo", message: "This view is not part of the recorded demo." };
      return toResult<T>(r.status, r.body);
    },
  };
}

export function localSource(): DataSource {
  return {
    mode: "local",
    async get<T>(path: string): Promise<ApiResult<T>> {
      let res: Response;
      try {
        res = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      } catch {
        return { ok: false, status: 0, code: "unreachable", message: "The local Agentlore server is not reachable. Is it still running?" };
      }
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("application/json")) return { ok: false, status: res.status, code: "not_json", message: `Unexpected response (${res.status}).` };
      return toResult<T>(res.status, await res.json());
    },
  };
}

/** True only when this page is served by the local bridge (not by a static host). */
export async function detectLocalBridge(): Promise<boolean> {
  const r = await localSource().get<{ product?: string; mode?: string }>("/api/health");
  return r.ok && r.value.product === "agentlore" && r.value.mode === "local";
}
