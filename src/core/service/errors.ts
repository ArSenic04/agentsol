import { sanitizeForTerminal } from "../display.ts";
import { err, type Result } from "../result.ts";

export const PUBLIC_ERROR_CODES = [
  "not_found", "invalid_input", "wrong_project", "stale_version", "rejected", "root_unavailable", "request_key_conflict", "internal_error",
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

/** Errors any caller (assistant, CLI, later web) may see. Never contains absolute paths, file text or stack traces. */
export type PublicError = { readonly code: PublicErrorCode; readonly message: string; readonly details?: unknown };
export type ServiceResult<T> = Result<T, PublicError>;

const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/)(?:Users|home|private|var|tmp|Volumes|opt|etc|root|mnt|srv)(?:[\\/][^\s"'`]*)?/g;

/** Defense in depth: strips absolute paths and terminal-unsafe characters from outgoing messages. */
export const publicText = (s: string): string => sanitizeForTerminal(s.replace(ABSOLUTE_PATH, "<path>")).slice(0, 500);

export const fail = (code: PublicErrorCode, message: string, details?: unknown): ServiceResult<never> =>
  err({ code, message: publicText(message), ...(details === undefined ? {} : { details }) });

export type InternalErrorSink = (operation: string, error: unknown) => void;

/** Converts unexpected exceptions into a generic internal_error; details go only to the local sink. */
export function guarded<T>(operation: string, sink: InternalErrorSink, fn: () => ServiceResult<T>): ServiceResult<T> {
  try {
    return fn();
  } catch (e) {
    sink(operation, e);
    return fail("internal_error", `${operation} failed unexpectedly; details are in the local server log`);
  }
}

export async function guardedAsync<T>(operation: string, sink: InternalErrorSink, fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (e) {
    sink(operation, e);
    return fail("internal_error", `${operation} failed unexpectedly; details are in the local server log`);
  }
}
