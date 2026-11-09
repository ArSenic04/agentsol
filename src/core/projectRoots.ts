import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isStrictlyInside } from "./paths.ts";
import { err, ok, type Result } from "./result.ts";
import { isSecretLikeDirName, isSecretLikeFileName } from "./secrets.ts";

/** System locations that are never project roots (exact or anything below them). */
const SYSTEM_SUBTREES = ["/etc", "/private/etc", "/System", "/Library", "/usr", "/bin", "/sbin", "/dev", "/proc", "/sys", "/boot", "/root"];
/** Broad locations refused as roots, though projects below them are fine. */
const BROAD_EXACT = ["/Users", "/home", "/Volumes", "/Applications", "/opt", "/var", "/private", "/private/var", "/tmp", "/private/tmp", "/mnt", "/media", "/srv"];
/** Folders directly inside home that hold many unrelated files. */
const HOME_CONTAINERS = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Public", "Applications", "Dropbox", "OneDrive", "Google Drive", "iCloud Drive", "Projects", "Developer", "src", "code", "repos", "git", "work"];
/** Subtrees inside home that hold app data, credentials or config. */
const HOME_SENSITIVE_SUBTREES = ["Library", ".config", ".local", ".cache", ".npm", ".cargo", ".rustup", ".claude", ".codex", ".cursor", ".vscode", ".Trash"];

export type RootCheckInput = { candidate: string; homeReal: string; workspaceDir: string };

const within = (base: string, p: string): boolean => p === base || isStrictlyInside(base, p);

/**
 * Decides whether a directory may be registered as a project root. Refuses the
 * filesystem root, system and app-data locations, home and anything containing it,
 * broad container folders, secret-like directories and the workspace itself.
 */
export async function validateProjectRoot(input: RootCheckInput): Promise<Result<string, string>> {
  let rootReal: string;
  try {
    rootReal = await realpath(path.resolve(input.candidate));
    const st = await lstat(rootReal);
    if (!st.isDirectory()) return err("Not a directory");
  } catch {
    return err("Path does not exist");
  }
  const home = input.homeReal;
  if (rootReal === path.parse(rootReal).root) return err("Refusing the filesystem root; pick a single project folder");
  if (SYSTEM_SUBTREES.some((s) => within(s, rootReal))) return err("Refusing a system location");
  if (BROAD_EXACT.includes(rootReal)) return err("Refusing a broad shared folder; pick a single project folder");
  if (within(rootReal, home)) return err("Refusing your home folder or a folder that contains it; pick a single project folder");
  if (path.dirname(rootReal) === home && HOME_CONTAINERS.some((c) => c.toLowerCase() === path.basename(rootReal).toLowerCase())) {
    return err(`Refusing ~/${path.basename(rootReal)} because it usually holds many unrelated files; register one project folder inside it`);
  }
  if (HOME_SENSITIVE_SUBTREES.some((s) => within(path.join(home, s), rootReal))) return err("Refusing an app-data or config folder");
  const parts = rootReal.split(path.sep).filter(Boolean);
  if (parts.some((p) => isSecretLikeDirName(p) || isSecretLikeFileName(p))) return err("Refusing a folder with a secret-like name");
  const ws = path.resolve(input.workspaceDir);
  const wsReal = await realpath(ws).catch(() => ws);
  if (rootReal === wsReal) return err("Refusing the AgentWeave workspace itself");
  if (isStrictlyInside(wsReal, rootReal)) return err("Refusing a folder inside the AgentWeave workspace");
  return ok(rootReal);
}

/** Confirms a registered root is still the same real, non-symlink directory. */
export async function verifyRegisteredRoot(rootReal: string): Promise<Result<true, string>> {
  try {
    const st = await lstat(rootReal);
    if (st.isSymbolicLink()) return err("Registered project root is now a symlink; refusing to read it");
    if (!st.isDirectory()) return err("Registered project root is no longer a directory");
    if ((await realpath(rootReal)) !== rootReal) return err("Registered project root now resolves somewhere else; refusing to read it");
    return ok(true);
  } catch {
    return err("Registered project root no longer exists");
  }
}
