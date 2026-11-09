/** Directories never descended into. */
export const SECRET_DIR_NAMES: ReadonlySet<string> = new Set([
  ".ssh", ".aws", ".gnupg", ".gcloud", ".azure", ".kube", ".docker", ".password-store",
  "secrets", ".secrets", "credentials", ".credentials", "private-keys", "keys",
]);
export const isSecretLikeDirName = (name: string): boolean => SECRET_DIR_NAMES.has(name.toLowerCase());

const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pgpass|pypirc|git-credentials)$/i,
  /credential/i,
  /secret/i,
];

export const isSecretLikeFileName = (name: string): boolean => SECRET_FILE_PATTERNS.some((re) => re.test(name));

export type SecretKind =
  | "private_key" | "aws_access_key" | "github_token" | "slack_token" | "api_key" | "jwt" | "bearer" | "url_credentials" | "assignment";

const TOKEN_PATTERNS: readonly { kind: SecretKind; re: RegExp }[] = [
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  {
    kind: "api_key",
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|hf_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9_-]{20,})/g,
  },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { kind: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi },
];
// Value-after-keyword assignments. Requires a separator and 6+ non-space characters
// so prose such as "use a strong password" is left alone.
const ASSIGNMENT = /\b(api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)\b(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi;
// Matches RSA/EC/OPENSSH/ENCRYPTED "PRIVATE KEY" and PGP "PRIVATE KEY BLOCK" armor.
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

export type RedactedLine = { readonly line: number; readonly kinds: readonly SecretKind[] };

/**
 * Pattern-based and therefore incomplete: unknown token formats, secrets split across
 * lines, or short values can pass through. This reduces exposure; it does not prevent it.
 *
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
