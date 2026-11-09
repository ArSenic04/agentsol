import path from "node:path";
import { findClaudeImports } from "./claudeImports.ts";
import { FORMAT_DOCS, fileDirOf, isSameOrBelow, scopeDirOf, type SourceFormat } from "./formats.ts";
import { readFrontmatter } from "./frontmatter.ts";
import { sha256Hex } from "./hash.ts";
import { findingIdFromDigest, type SourceId, type VersionId } from "./ids.ts";
import { normalizeRelPath, resolveExistingInsideRoot } from "./paths.ts";
import type { EvidenceSpan, Severity, StructuralCheckId, StructuralFinding } from "./schemas.ts";
import { isSecretLikeDirName, isSecretLikeFileName } from "./secrets.ts";

export type CheckSource = {
  readonly sourceId: SourceId;
  readonly versionId: VersionId;
  readonly relPath: string;
  readonly format: SourceFormat;
  /** Redacted lines (what the store holds and what clients may quote). */
  readonly lines: readonly string[];
  readonly redactedLineNumbers: readonly number[];
  readonly byteLength: number;
};

export type CheckContext = { readonly rootReal: string; readonly sources: readonly CheckSource[] };

/** Catalog of deterministic checks. Each one reports a structural fact, never a conflict. */
export const STRUCTURAL_CHECKS: Record<StructuralCheckId, string> = {
  D00: "Instruction file is empty",
  D01: "SKILL.md frontmatter is missing or invalid",
  D02: "Skill name breaks the Agent Skills naming rules or does not match its folder",
  D03: "Skill description is missing or too long",
  D04: "Skill compatibility field is too long",
  D07: "File exceeds a documented size limit or guideline",
  D08: "File is not read by a client by default because another file takes precedence",
  D09: "CLAUDE.md @import cannot be resolved inside the project",
  D10: "Identical line appears in more than one instruction file",
  D12: "Secret-like text found (redacted)",
};

const CODEX_MAX_BYTES = 32 * 1024;
const CLAUDE_MD_LINE_GUIDE = 200;
const SKILL_BODY_LINE_GUIDE = 500;
const SKILL_NAME = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;
const MIN_DUPLICATE_LENGTH = 24;
const MAX_DUPLICATE_FINDINGS = 25;

export function span(src: CheckSource, startLine: number, endLine: number): EvidenceSpan {
  const total = Math.max(1, src.lines.length);
  const s = Math.min(Math.max(1, startLine), total);
  const e = Math.min(Math.max(s, endLine), total);
  return {
    sourceId: src.sourceId,
    versionId: src.versionId,
    relPath: src.relPath,
    startLine: s,
    endLine: e,
    textSha256: sha256Hex(src.lines.slice(s - 1, e).join("\n")),
  };
}

function finding(args: {
  checkId: StructuralCheckId;
  severity: Severity;
  message: string;
  evidence: [EvidenceSpan, ...EvidenceSpan[]];
  docUrl: string;
}): StructuralFinding {
  const digest = sha256Hex(
    JSON.stringify([args.checkId, args.message, args.evidence.map((e) => [e.sourceId, e.versionId, e.startLine, e.endLine])]),
  );
  return {
    kind: "structural",
    id: findingIdFromDigest(digest),
    checkId: args.checkId,
    severity: args.severity,
    title: STRUCTURAL_CHECKS[args.checkId],
    message: args.message,
    evidence: args.evidence,
    docUrl: args.docUrl,
  };
}

const lineOfKey = (lines: readonly string[], key: string, endLine: number): number => {
  const idx = lines.slice(0, endLine).findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  return idx === -1 ? 1 : idx + 1;
};

function skillChecks(src: CheckSource, rootReal: string): StructuralFinding[] {
  const out: StructuralFinding[] = [];
  const doc = FORMAT_DOCS["skill-md"];
  const fm = readFrontmatter(src.lines);
  if (fm.kind === "none") {
    return [finding({ checkId: "D01", severity: "error", message: "SKILL.md has no YAML frontmatter; the spec requires `name` and `description`.", evidence: [span(src, 1, 1)], docUrl: doc })];
  }
  if (fm.kind === "error") {
    return [finding({ checkId: "D01", severity: "error", message: fm.message, evidence: [span(src, 1, fm.endLine)], docUrl: doc })];
  }
  const dirName = path.posix.basename(fileDirOf(src.relPath)) || path.basename(rootReal);
  const name = fm.data["name"];
  const nameLine = lineOfKey(src.lines, "name", fm.endLine);
  if (typeof name !== "string" || name.length === 0) {
    out.push(finding({ checkId: "D02", severity: "error", message: "Frontmatter `name` is missing or not a string.", evidence: [span(src, 1, fm.endLine)], docUrl: doc }));
  } else {
    const problems: string[] = [];
    if (name.length > 64) problems.push("is longer than 64 characters");
    if (!SKILL_NAME.test(name)) problems.push("must use lowercase letters, digits and single hyphens, not starting or ending with a hyphen");
    if (name !== dirName) problems.push(`does not match its folder name \`${dirName}\``);
    if (problems.length > 0) {
      out.push(finding({ checkId: "D02", severity: "error", message: `Skill name \`${name}\` ${problems.join("; ")}.`, evidence: [span(src, nameLine, nameLine)], docUrl: doc }));
    }
  }
  const description = fm.data["description"];
  const descLine = lineOfKey(src.lines, "description", fm.endLine);
  if (typeof description !== "string" || description.trim().length === 0) {
    out.push(finding({ checkId: "D03", severity: "error", message: "Frontmatter `description` is missing or empty.", evidence: [span(src, 1, fm.endLine)], docUrl: doc }));
  } else if (description.length > 1024) {
    out.push(finding({ checkId: "D03", severity: "error", message: `Description is ${description.length} characters; the spec maximum is 1024.`, evidence: [span(src, descLine, descLine)], docUrl: doc }));
  }
  const compatibility = fm.data["compatibility"];
  if (typeof compatibility === "string" && compatibility.length > 500) {
    const line = lineOfKey(src.lines, "compatibility", fm.endLine);
    out.push(finding({ checkId: "D04", severity: "warn", message: `compatibility is ${compatibility.length} characters; the spec maximum is 500.`, evidence: [span(src, line, line)], docUrl: doc }));
  }
  const bodyLines = src.lines.length - fm.endLine;
  if (bodyLines > SKILL_BODY_LINE_GUIDE) {
    out.push(finding({ checkId: "D07", severity: "info", message: `SKILL.md body is ${bodyLines} lines; the spec recommends under ${SKILL_BODY_LINE_GUIDE}.`, evidence: [span(src, fm.endLine + 1, src.lines.length)], docUrl: doc }));
  }
  return out;
}

async function claudeImportChecks(src: CheckSource, rootReal: string): Promise<StructuralFinding[]> {
  const out: StructuralFinding[] = [];
  const doc = FORMAT_DOCS["claude-md"];
  for (const imp of findClaudeImports(src.lines)) {
    if (imp.kind === "home") continue; // outside the project by design; not inspected
    const ev: [EvidenceSpan] = [span(src, imp.line, imp.line)];
    if (imp.kind === "absolute") {
      out.push(finding({ checkId: "D09", severity: "info", message: `Import \`@${imp.raw}\` is an absolute path outside the project; Agentsol does not inspect it.`, evidence: ev, docUrl: doc }));
      continue;
    }
    const joined = path.posix.normalize(path.posix.join(fileDirOf(src.relPath) || ".", imp.raw));
    const norm = normalizeRelPath(joined);
    if (!norm.ok) {
      out.push(finding({ checkId: "D09", severity: "warn", message: `Import \`@${imp.raw}\` resolves outside the project root; Agentsol does not follow it.`, evidence: ev, docUrl: doc }));
      continue;
    }
    if (norm.value.split("/").some((part) => isSecretLikeDirName(part) || isSecretLikeFileName(part))) {
      out.push(finding({ checkId: "D09", severity: "info", message: `Import \`@${imp.raw}\` has a secret-like name; not checked. Importing such a file would send it to the model.`, evidence: ev, docUrl: doc }));
      continue;
    }
    const resolved = await resolveExistingInsideRoot(rootReal, norm.value);
    if (!resolved.ok && resolved.error.code === "not_found") {
      out.push(finding({ checkId: "D09", severity: "warn", message: `Import \`@${imp.raw}\` points to \`${norm.value}\`, which does not exist.`, evidence: ev, docUrl: doc }));
    } else if (!resolved.ok) {
      out.push(finding({ checkId: "D09", severity: "info", message: `Import \`@${imp.raw}\` could not be checked: ${resolved.error.message}.`, evidence: ev, docUrl: doc }));
    }
  }
  return out;
}

function precedenceChecks(src: CheckSource, all: readonly CheckSource[]): StructuralFinding[] {
  if (src.format !== "agents-md") return [];
  const out: StructuralFinding[] = [];
  const dir = scopeDirOf(src.relPath, src.format);
  const override = all.find((o) => o.format === "agents-override-md" && scopeDirOf(o.relPath, o.format) === dir && o.lines.some((l) => l.trim() !== ""));
  if (override) {
    out.push(finding({
      checkId: "D08",
      severity: "info",
      message: `Codex reads \`${override.relPath}\` instead of this AGENTS.md in the same directory (one file per directory, override first).`,
      evidence: [span(src, 1, 1), span(override, 1, 1)],
      docUrl: FORMAT_DOCS["agents-md"],
    }));
  }
  const claude = all.find((o) => (o.format === "claude-md" || o.format === "claude-local-md") && isSameOrBelow(dir, scopeDirOf(o.relPath, o.format)));
  if (claude) {
    out.push(finding({
      checkId: "D08",
      severity: "info",
      message: `With its default "Project instructions" setting, Claude Code reads CLAUDE.md files instead of AGENTS.md when \`${claude.relPath}\` applies to this directory. Other clients (Codex, Cursor) still read this file.`,
      evidence: [span(src, 1, 1), span(claude, 1, 1)],
      docUrl: FORMAT_DOCS["claude-md"],
    }));
  }
  return out;
}

function sizeChecks(src: CheckSource): StructuralFinding[] {
  if ((src.format === "agents-md" || src.format === "agents-override-md") && src.byteLength > CODEX_MAX_BYTES) {
    return [finding({ checkId: "D07", severity: "warn", message: `File is ${src.byteLength} bytes; Codex stops adding instruction files once the combined size reaches 32 KiB by default (project_doc_max_bytes).`, evidence: [span(src, 1, src.lines.length)], docUrl: FORMAT_DOCS["agents-md"] })];
  }
  if ((src.format === "claude-md" || src.format === "claude-local-md") && src.lines.length > CLAUDE_MD_LINE_GUIDE) {
    return [finding({ checkId: "D07", severity: "info", message: `File is ${src.lines.length} lines; Anthropic recommends under ${CLAUDE_MD_LINE_GUIDE} lines per CLAUDE.md.`, evidence: [span(src, 1, src.lines.length)], docUrl: FORMAT_DOCS["claude-md"] })];
  }
  return [];
}

function secretChecks(src: CheckSource): StructuralFinding[] {
  if (src.redactedLineNumbers.length === 0) return [];
  const spans = src.redactedLineNumbers.slice(0, 10).map((n) => span(src, n, n));
  const [first, ...rest] = spans;
  if (!first) return [];
  return [finding({
    checkId: "D12",
    severity: "warn",
    message: `${src.redactedLineNumbers.length} line(s) contain secret-like text. Matched values are blanked in Agentsol's stored copy and tool output (pattern-based, so other secrets can be missed). Move secrets out of instruction files: every assistant that reads this file sees the original.`,
    evidence: [first, ...rest],
    docUrl: "https://agentskills.io/specification",
  })];
}

const normalizeForDuplicate = (line: string): string => line.trim().replace(/\s+/g, " ");

function duplicateChecks(sources: readonly CheckSource[]): StructuralFinding[] {
  const occurrences = new Map<string, { src: CheckSource; line: number }[]>();
  for (const src of sources) {
    const redacted = new Set(src.redactedLineNumbers);
    const seenInThisSource = new Set<string>();
    src.lines.forEach((raw, i) => {
      const key = normalizeForDuplicate(raw);
      if (key.length < MIN_DUPLICATE_LENGTH || key.startsWith("```") || redacted.has(i + 1) || seenInThisSource.has(key)) return;
      seenInThisSource.add(key);
      const list = occurrences.get(key) ?? [];
      list.push({ src, line: i + 1 });
      occurrences.set(key, list);
    });
  }
  const out: StructuralFinding[] = [];
  for (const [, list] of occurrences) {
    if (list.length < 2 || out.length >= MAX_DUPLICATE_FINDINGS) continue;
    const spans = list.slice(0, 10).map((o) => span(o.src, o.line, o.line));
    const [first, ...rest] = spans;
    if (!first) continue;
    out.push(finding({
      checkId: "D10",
      severity: "info",
      message: `The same line appears in ${list.length} instruction files. This is identical text, not a conflict; layered files often repeat guidance on purpose.`,
      evidence: [first, ...rest],
      docUrl: FORMAT_DOCS["agents-md"],
    }));
  }
  return out;
}

/** Runs every deterministic check. Reads nothing except existence of @import targets. */
export async function runStructuralChecks(ctx: CheckContext): Promise<StructuralFinding[]> {
  const out: StructuralFinding[] = [];
  for (const src of ctx.sources) {
    if (src.lines.every((l) => l.trim() === "")) {
      out.push(finding({ checkId: "D00", severity: "info", message: "File is empty or whitespace-only; clients skip or gain nothing from it.", evidence: [span(src, 1, 1)], docUrl: FORMAT_DOCS[src.format] }));
      continue;
    }
    if (src.format === "skill-md") out.push(...skillChecks(src, ctx.rootReal));
    if (src.format === "claude-md" || src.format === "claude-local-md") out.push(...(await claudeImportChecks(src, ctx.rootReal)));
    out.push(...precedenceChecks(src, ctx.sources), ...sizeChecks(src), ...secretChecks(src));
  }
  out.push(...duplicateChecks(ctx.sources));
  const unique = new Map(out.map((f) => [f.id, f]));
  return [...unique.values()];
}
