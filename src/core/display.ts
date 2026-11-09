/**
 * Characters that can rewrite or hide terminal output (C0/C1 controls, DEL) or reorder
 * how text is displayed (Unicode bidi embeddings, overrides and isolates, "Trojan Source").
 * Tab is allowed.
 */
export const UNSAFE_TEXT_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export const hasUnsafeTextChars = (s: string): boolean => new RegExp(UNSAFE_TEXT_CHARS.source).test(s);

/** Makes untrusted text safe to print: unsafe characters become visible \u{..} escapes. */
export const sanitizeForTerminal = (s: string): string =>
  s.replace(UNSAFE_TEXT_CHARS, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
