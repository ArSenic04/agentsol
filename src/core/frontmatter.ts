import { parse as parseYaml } from "yaml";

export type Frontmatter =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly data: Record<string, unknown>; readonly endLine: number }
  | { readonly kind: "error"; readonly message: string; readonly endLine: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses YAML frontmatter between a first-line `---` and the next `---` line. */
export function readFrontmatter(lines: readonly string[]): Frontmatter {
  if (lines[0]?.trim() !== "---") return { kind: "none" };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close === -1) return { kind: "error", message: "Frontmatter starts with --- but is never closed", endLine: 1 };
  const source = lines.slice(1, close).join("\n");
  try {
    const data: unknown = parseYaml(source, { maxAliasCount: 10, uniqueKeys: true, prettyErrors: false });
    if (!isRecord(data)) return { kind: "error", message: "Frontmatter is not a key/value mapping", endLine: close + 1 };
    return { kind: "ok", data, endLine: close + 1 };
  } catch (e) {
    const first = e instanceof Error ? (e.message.split("\n")[0] ?? "") : "";
    return { kind: "error", message: `Frontmatter is not valid YAML: ${first.slice(0, 200)}`, endLine: close + 1 };
  }
}
