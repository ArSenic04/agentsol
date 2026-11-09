/** Directories never descended into. */
export const SECRET_DIR_NAMES: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".gcloud", ".azure", ".kube", ".docker", ".password-store"]);

const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pgpass|pypirc|git-credentials)$/i,
  /credential/i,
  /secret/i,
];

export const isSecretLikeFileName = (name: string): boolean => SECRET_FILE_PATTERNS.some((re) => re.test(name));

export type SecretKind = "private_key" | "aws_access_key" | "github_token" | "slack_token" | "api_key" | "assignment";

const TOKEN_PATTERNS: readonly { kind: SecretKind; re: RegExp }[] = [
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "api_key", re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35})/g },
];
const ASSIGNMENT = /\b(api[_-]?key|secret|token|password|passwd)\b(\s*[:=]\s*)(["']?)([^\s"']{12,})\3/gi;
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export type RedactedLine = { readonly line: number; readonly kinds: readonly SecretKind[] };

/**
 * Replaces secret-like substrings line by line. Line count is preserved so evidence
 * line numbers stay valid. The original values are never returned or stored.
 */
export function redactLines(lines: readonly string[]): { lines: string[]; redacted: RedactedLine[] } {
  const out: string[] = [];
  const redacted: RedactedLine[] = [];
  let inKey = false;
  lines.forEach((original, index) => {
    const kinds = new Set<SecretKind>();
    let line = original;
    if (inKey || KEY_BEGIN.test(line)) {
      const ends = KEY_END.test(line);
      inKey = !ends;
      kinds.add("private_key");
      line = "[REDACTED:private_key]";
    } else {
      for (const { kind, re } of TOKEN_PATTERNS) {
        line = line.replace(re, () => {
          kinds.add(kind);
          return `[REDACTED:${kind}]`;
        });
      }
      line = line.replace(ASSIGNMENT, (match: string, key: string, sep: string, quote: string, value: string) => {
        if (value.startsWith("[REDACTED:")) return match;
        kinds.add("assignment");
        return `${key}${sep}${quote}[REDACTED:assignment]${quote}`;
      });
    }
    out.push(line);
    if (kinds.size > 0) redacted.push({ line: index + 1, kinds: [...kinds] });
  });
  return { lines: out, redacted };
}

export const containsSecretLike = (text: string): boolean => redactLines(text.split(/\r?\n/)).redacted.length > 0;
