import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { err, ok, type Result } from "./result.ts";

export type ReadErrorCode = "symlink" | "not_regular_file" | "too_large" | "not_found" | "io";
export type ReadError = { readonly code: ReadErrorCode; readonly message: string };

const errorCode = (e: unknown): string | undefined =>
  e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;

/**
 * Reads a regular file without following a final-component symlink (O_NOFOLLOW) and
 * without blocking on FIFOs (O_NONBLOCK). Enforces a byte cap before and after reading.
 */
export async function readRegularFileNoFollow(
  absPath: string,
  maxBytes: number,
): Promise<Result<{ bytes: Buffer; mode: number }, ReadError>> {
  let handle;
  try {
    handle = await open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = errorCode(e);
    if (code === "ELOOP" || code === "EMLINK") return err({ code: "symlink", message: "Refusing to follow a symlink" });
    if (code === "ENOENT") return err({ code: "not_found", message: "File not found" });
    return err({ code: "io", message: `Could not open file (${code ?? "unknown error"})` });
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return err({ code: "not_regular_file", message: "Not a regular file" });
    if (st.size > maxBytes) return err({ code: "too_large", message: `File is larger than ${maxBytes} bytes` });
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) return err({ code: "too_large", message: `File is larger than ${maxBytes} bytes` });
    return ok({ bytes, mode: st.mode & 0o777 });
  } catch (e) {
    return err({ code: "io", message: `Could not read file (${errorCode(e) ?? "unknown error"})` });
  } finally {
    await handle.close();
  }
}
