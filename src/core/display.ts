/**
 * Characters that can rewrite or hide terminal output (C0/C1 controls, DEL) or reorder
 * how text is displayed (Unicode bidi embeddings, overrides and isolates, "Trojan Source").
 * Also zero-width and Unicode tag characters, which hide text from a reader. Tab and the
 * zero-width joiner inside emoji are allowed.
 */
export const UNSAFE_TEXT_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|[\u{e0000}-\u{e007f}]/gu;

export const hasUnsafeTextChars = (s: string): boolean => new RegExp(UNSAFE_TEXT_CHARS.source, "u").test(s);

/** Makes untrusted text safe to print: unsafe characters become visible \u{..} escapes. */
export const sanitizeForTerminal = (s: string): string =>
  s.replace(UNSAFE_TEXT_CHARS, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
