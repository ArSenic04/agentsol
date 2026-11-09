import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "./result.ts";

export type PathErrorCode =
  | "empty"
  | "nul_byte"
  | "backslash"
  | "absolute"
  | "traversal"
  | "symlink"
  | "outside_root"
  | "not_found";

export type PathError = { readonly code: PathErrorCode; readonly message: string };

/**
 * Normalizes a project-relative POSIX path. Rejects absolute paths, `..` segments,
 * NUL bytes and backslashes instead of trying to repair them.
 */
export function normalizeRelPath(input: string): Result<string, PathError> {
  if (input.includes("\0")) return err({ code: "nul_byte", message: "Path contains a NUL byte" });
  if (input.includes("\\")) return err({ code: "backslash", message: "Use forward slashes in project paths" });
  if (path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    return err({ code: "absolute", message: "Absolute paths are not allowed; use a path relative to the project root" });
  }
  const parts = input.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) return err({ code: "traversal", message: "Path may not contain '..' segments" });
  if (parts.length === 0) return err({ code: "empty", message: "Path is empty" });
  return ok(parts.join("/"));
}

export function isStrictlyInside(rootReal: string, candidate: string): boolean {
  const rel = path.relative(rootReal, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves an existing path inside `rootReal` without following symlinks in any
 * component, then double-checks the real path is still inside the root.
 */
export async function resolveExistingInsideRoot(rootReal: string, rel: string): Promise<Result<string, PathError>> {
  const norm = normalizeRelPath(rel);
  if (!norm.ok) return norm;
  let current = rootReal;
  for (const part of norm.value.split("/")) {
    current = path.join(current, part);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        return err({ code: "symlink", message: `Path component is a symlink and is not followed: ${path.relative(rootReal, current)}` });
      }
    } catch {
      return err({ code: "not_found", message: `Path does not exist: ${norm.value}` });
    }
  }
  const real = await realpath(current);
  if (!isStrictlyInside(rootReal, real)) return err({ code: "outside_root", message: "Path resolves outside the project root" });
  return ok(real);
}
