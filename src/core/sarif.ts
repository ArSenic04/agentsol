import path from "node:path";
import { STRUCTURAL_CHECKS } from "./checks.ts";
import { sha256Hex } from "./hash.ts";
import type { SemanticFinding, StructuralFinding } from "./schemas.ts";
import { SEMANTIC_CHECKS } from "./semantic.ts";
import { PRODUCT_VERSION } from "./version.ts";

const REPO = "https://github.com/ArSenic04/agentsol";
const HELP = `${REPO}#check--a-report-you-can-act-on`;
const LEVEL = { error: "error", warn: "warning", info: "note" } as const;

type Finding = StructuralFinding | SemanticFinding;

/**
 * SARIF 2.1.0 for `check`. Uris are relative to `baseDir` (the CI checkout) so code scanning can place them;
 * messages are the same redacted text Agentsol prints, never file contents.
 */
export function checkSarif(findings: readonly Finding[], projectRoot: string, baseDir: string, lineText: (relPath: string, line: number) => string | undefined = () => undefined): Record<string, unknown> {
  const rules = [
    ...Object.entries(STRUCTURAL_CHECKS).map(([id, title]) => ({ id, title, possible: false })),
    ...Object.entries(SEMANTIC_CHECKS).map(([id, c]) => ({ id, title: c.title, possible: true })),
  ];
  const index = new Map(rules.map((r, i) => [r.id, i]));
  const prefix = path.relative(baseDir, projectRoot);
  const inside = !prefix.startsWith("..") && !path.isAbsolute(prefix);
  const uriOf = (relPath: string): string => (inside ? path.join(prefix, relPath) : relPath).split(path.sep).join("/");
  // Outside the checkout the uris stay relative to the checked folder, named but not located (no absolute paths).
  const base = inside ? {} : { uriBaseId: "PROJECTROOT" };
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      ...(inside ? {} : { originalUriBaseIds: { PROJECTROOT: { description: { text: "The folder Agentsol checked, outside the working directory." } } } }),
      tool: {
        driver: {
          name: "Agentsol",
          version: PRODUCT_VERSION,
          informationUri: REPO,
          rules: rules.map((r) => ({
            id: r.id,
            name: r.id,
            shortDescription: { text: r.title },
            fullDescription: { text: r.possible ? `${r.title}. Reported by an AI assistant as possible, with a quoted span checked against the file.` : `${r.title}. Deterministic check; the finding is a fact about the file.` },
            helpUri: HELP,
            properties: { tags: r.possible ? ["agent-instructions", "possible"] : ["agent-instructions"] },
          })),
        },
      },
      results: findings.map((f) => {
        const ev = f.evidence[0];
        const uri = ev ? uriOf(ev.relPath) : "";
        const quoted = ev ? lineText(ev.relPath, ev.startLine)?.replace(/\s+/g, " ").trim() : undefined;
        return {
          ruleId: f.checkId,
          ruleIndex: index.get(f.checkId) ?? 0,
          level: LEVEL[f.severity],
          message: { text: f.message },
          locations: f.evidence.slice(0, 10).map((e) => ({
            physicalLocation: { artifactLocation: { uri: uriOf(e.relPath), ...base }, region: { startLine: e.startLine, endLine: Math.max(e.startLine, e.endLine) } },
          })),
          // From the flagged line's text, not its number, so a finding keeps its identity when lines above it move.
          partialFingerprints: { "agentsolFinding/v1": sha256Hex(`${f.checkId}\n${uri}\n${quoted || f.message.replace(/\d+/g, "")}`).slice(0, 32) },
          ...(f.kind === "semantic" ? { properties: { claim: "possible", confidence: f.confidence } } : {}),
        };
      }),
    }],
  };
}
