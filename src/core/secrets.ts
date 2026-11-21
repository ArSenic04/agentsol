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

// Values that are clearly not live credentials: documentation samples, masked output,
// templates. They are still blanked, but are not reported as an exposed secret.
const PLACEHOLDER = /fake|example|dummy|placeholder|sample|redacted|changeme|your[_-]|x{4,}|\*{3,}|•{3,}|<[^>]*>|\$\{|\{\{/i;
const isPlaceholder = (v: string): boolean => PLACEHOLDER.test(v) || new Set(v.replace(/^[a-z]+[-_]/i, "")).size <= 4;
// Code and config that names a value instead of holding it: `token: string`, `apiKey: process.env.KEY`,
// `password=$(read_pw)`, `secret: z.string()`, `TOKEN=GITHUB_TOKEN`.
const TYPE_WORDS = /^(string|number|boolean|bool|int|integer|float|str|bytes|any|unknown|object|null|undefined|none|nil|true|false|optional|required)$/i;
const CODE_REF = /^[$%@&{([<]|^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$|^[A-Za-z_$][\w$.]*\(.*$|^[A-Z][A-Z0-9_]{2,}$/;
// Field names and prose (`token:distinct_id`, "a token: Settings"). Lone lowercase words stay flagged: they can be passwords.
const WORD = /^([a-z]+(_[a-z]+)+|[A-Z][a-z]+)$/;
const isCodeReference = (v: string): boolean => { const t = v.replace(/^`+/, "").replace(/[,;:.)\]}`]+$/, ""); return t.length < 6 || TYPE_WORDS.test(t) || CODE_REF.test(t) || WORD.test(t); };

/** `kinds`: everything blanked on the line. `real`: the subset that is not a placeholder. */
export type RedactedLine = { readonly line: number; readonly kinds: readonly SecretKind[]; readonly real: readonly SecretKind[] };

const SECRET_LABEL: Record<SecretKind, string> = {
  private_key: "a private key", aws_access_key: "an AWS access key", github_token: "a GitHub token", slack_token: "a Slack token",
  api_key: "an API key", jwt: "a JSON web token", bearer: "a bearer token", url_credentials: "a password inside a URL", assignment: "a secret value",
};
export const secretLabel = (kind: SecretKind): string => SECRET_LABEL[kind];

/**
 * Pattern-based and therefore incomplete: unknown token formats, secrets split across
 * lines, or short values can pass through. This reduces exposure; it does not prevent it.
 *
 * Replaces secret-like substrings line by line. Line count is preserved so evidence
 * line numbers stay valid. The original values are never returned or stored.
 */
export function redactLines(lines: readonly string[]): { lines: string[]; redacted: RedactedLine[] } {
  const out: string[] = [];
  const redacted: { line: number; kinds: SecretKind[]; real: SecretKind[] }[] = [];
  let inKey = false;
  let keyStart = 0;
  let keyBody = "";
  // A key block counts as real only if its body is long enough to be a key and is not a sample.
  const settleKey = (): void => {
    if (keyBody.replace(/[^A-Za-z0-9+/=]/g, "").length >= 64 && !isPlaceholder(keyBody)) return;
    for (const r of redacted.slice(keyStart)) r.real = r.real.filter((k) => k !== "private_key");
  };
  lines.forEach((original, index) => {
    const kinds = new Set<SecretKind>();
    const real = new Set<SecretKind>();
    const hit = (kind: SecretKind, value: string): void => { kinds.add(kind); if (!isPlaceholder(value)) real.add(kind); };
    let line = original;
    let settle = false;
    if (inKey || KEY_BEGIN.test(line)) {
      if (!inKey) { keyStart = redacted.length; keyBody = ""; } else if (!KEY_END.test(line)) keyBody += line.trim();
      const ends = KEY_END.test(line);
      inKey = !ends;
      settle = ends;
      kinds.add("private_key");
      real.add("private_key");
      line = "[REDACTED:private_key]";
    } else {
      for (const { kind, re } of TOKEN_PATTERNS) {
        line = line.replace(re, (m: string) => {
          hit(kind, m);
          return `[REDACTED:${kind}]`;
        });
      }
      line = line.replace(ASSIGNMENT, (match: string, key: string, sep: string, quote: string, value: string) => {
        if (value.includes("[REDACTED:") || isCodeReference(value)) return match;
        hit("assignment", value);
        return `${key}${sep}${quote}[REDACTED:assignment]${quote}`;
      });
    }
    out.push(line);
    if (kinds.size > 0) redacted.push({ line: index + 1, kinds: [...kinds], real: [...real] });
    if (settle) settleKey();
  });
  if (inKey) settleKey();
  return { lines: out, redacted };
}

/** Kinds of real (non-placeholder) secrets in the text, most specific first. */
export const secretKinds = (text: string): SecretKind[] => [...new Set(redactLines(text.split(/\r?\n/)).redacted.flatMap((r) => r.real))];

export const containsSecretLike = (text: string): boolean => redactLines(text.split(/\r?\n/)).redacted.length > 0;

/** Label of the first real secret on a line, for reports that must never show the value. */
export const secretIn = (line: string): string | null => { const k = secretKinds(line)[0]; return k ? secretLabel(k) : null; };
