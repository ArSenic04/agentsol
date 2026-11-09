/**
 * Read-only HTTP API over the assistant-safe service. Shared by the local bridge and by
 * the build step that records the static demo, so both produce identical shapes.
 * Exposes no scan, write, approval, apply, registration or file-path parameters.
 */
import type { AssistantService } from "../core/service/assistant.ts";
import type { PublicErrorCode, ServiceResult } from "../core/service/errors.ts";

export type ApiResponse = { status: number; body: unknown };

const STATUS_FOR: Record<PublicErrorCode, number> = {
  not_found: 404, invalid_input: 400, wrong_project: 400, stale_version: 409, rejected: 422,
  root_unavailable: 409, request_key_conflict: 409, internal_error: 500,
};

const respond = <T>(r: ServiceResult<T>): ApiResponse => (r.ok ? { status: 200, body: r.value } : { status: STATUS_FOR[r.error.code], body: { error: r.error } });
const notFound = (): ApiResponse => ({ status: 404, body: { error: { code: "not_found", message: "No such API route" } } });

export const API_VERSION = 1;

/** `segments` is the URL path split on "/" after "/api/". Ids are validated by the service. */
export async function handleApi(svc: AssistantService, segments: readonly string[], query: URLSearchParams): Promise<ApiResponse> {
  const [a, b, c, ...rest] = segments;
  if (rest.length > 0) return notFound();
  const int = (k: string): number | undefined => {
    const v = query.get(k);
    return v !== null && /^\d{1,7}$/.test(v) ? Number(v) : undefined;
  };
  if (a === "health" && b === undefined) return { status: 200, body: { product: "agentsol", mode: "local", readOnly: true, apiVersion: API_VERSION } };
  if (a === "status" && b === undefined) return respond(await svc.status());
  if (a === "sources" && b !== undefined && c === undefined) {
    const start = int("start");
    const end = int("end");
    return respond(svc.readSource({ sourceId: b, ...(start ? { startLine: start } : {}), ...(end ? { endLine: end } : {}) }));
  }
  if (a === "projects" && b !== undefined) {
    const projectId = b;
    switch (c) {
      case "sources": return respond(svc.listSources({ projectId }));
      case "findings": return respond(svc.listFindings({ projectId }));
      case "freshness": return respond(await svc.freshness({ projectId }));
      case "proposals": return respond(svc.listProposals({ projectId }));
      case "scope": {
        const cwd = query.get("cwd");
        return respond(svc.resolveScope({ projectId, targetPath: query.get("target") ?? "", platform: query.get("platform") ?? "", ...(cwd ? { workingDirectory: cwd } : {}) }));
      }
      default: return notFound();
    }
  }
  return notFound();
}
