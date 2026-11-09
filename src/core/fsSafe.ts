import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolveExistingInsideRoot } from "./paths.ts";
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

export type InsideReadErrorCode = ReadErrorCode | "path_rejected" | "hard_link" | "swapped";
export type InsideRead = { bytes: Buffer; mode: number; dev: number; ino: number; absPath: string };
export type InsideReadError = { readonly code: InsideReadErrorCode; readonly message: string };

/**
 * Reads `rel` inside `rootReal` and proves the bytes came from a file reachable through
 * a symlink-free path inside the root: the opened handle's (dev, ino) must equal the
 * inode found by a component-by-component lstat walk done after opening. Files with
 * more than one hard link are refused because a hard link can point at data outside
 * the project. Node has no openat/O_BENEATH, so this narrows but cannot fully close
 * races with a concurrent attacker who can rewrite directories inside the project.
 */
export async function readFileInsideRoot(
  rootReal: string,
  rel: string,
  maxBytes: number,
): Promise<Result<InsideRead, InsideReadError>> {
  const pre = await resolveExistingInsideRoot(rootReal, rel);
  if (!pre.ok) return err({ code: pre.error.code === "symlink" ? "symlink" : pre.error.code === "not_found" ? "not_found" : "path_rejected", message: pre.error.message });
  let handle;
  try {
    handle = await open(pre.value, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = errorCode(e);
    if (code === "ELOOP" || code === "EMLINK") return err({ code: "symlink", message: "Refusing to follow a symlink" });
    if (code === "ENOENT") return err({ code: "not_found", message: "File not found" });
    return err({ code: "io", message: `Could not open file (${code ?? "unknown error"})` });
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return err({ code: "not_regular_file", message: "Not a regular file" });
    if (st.nlink > 1) return err({ code: "hard_link", message: "File has more than one hard link; not read" });
    if (st.size > maxBytes) return err({ code: "too_large", message: `File is larger than ${maxBytes} bytes` });
    const post = await resolveExistingInsideRoot(rootReal, rel);
    if (!post.ok) return err({ code: "swapped", message: "Path changed while reading; not read" });
    const now = await lstat(post.value);
    if (now.dev !== st.dev || now.ino !== st.ino) return err({ code: "swapped", message: "Path changed while reading; not read" });
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) return err({ code: "too_large", message: `File is larger than ${maxBytes} bytes` });
    return ok({ bytes, mode: st.mode & 0o777, dev: st.dev, ino: st.ino, absPath: post.value });
  } catch (e) {
    return err({ code: "io", message: `Could not read file (${errorCode(e) ?? "unknown error"})` });
  } finally {
    await handle.close();
  }
}
