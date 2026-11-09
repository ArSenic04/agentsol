import { err, ok, type Result } from "./result.ts";

/**
 * A text file split into lines in a way that can be reassembled byte-for-byte
 * (BOM, line ending style, trailing newline) when the file has one line ending style.
 */
export type TextShape = {
  readonly lines: string[];
  readonly eol: "\n" | "\r\n";
  readonly trailingNewline: boolean;
  readonly bom: boolean;
  readonly mixedLineEndings: boolean;
};

export type DecodeError = { readonly code: "binary" | "invalid_utf8"; readonly message: string };

export function decodeUtf8Strict(bytes: Uint8Array): Result<string, DecodeError> {
  if (bytes.includes(0)) return err({ code: "binary", message: "File contains NUL bytes; treated as binary" });
  try {
    return ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return err({ code: "invalid_utf8", message: "File is not valid UTF-8" });
  }
}

export function toShape(text: string): TextShape {
  const bom = text.startsWith("\uFEFF");
  const content = bom ? text.slice(1) : text;
  const crlfCount = content.split("\r\n").length - 1;
  const lfCount = content.split("\n").length - 1;
  const eol = crlfCount > 0 ? "\r\n" : "\n";
  const mixedLineEndings = crlfCount > 0 && crlfCount !== lfCount;
  const trailingNewline = content.endsWith("\n");
  const body = trailingNewline ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
  return { lines: body.split(/\r?\n/), eol, trailingNewline, bom, mixedLineEndings };
}

export function fromShape(shape: TextShape): string {
  const joined = shape.lines.join(shape.eol);
  return (shape.bom ? "\uFEFF" : "") + (shape.trailingNewline ? joined + shape.eol : joined);
}

/** Normalizes a quoted multi-line string from a client (CRLF and one trailing newline). */
export function normalizeQuote(quote: string): string {
  const unified = quote.replace(/\r\n/g, "\n");
  return unified.endsWith("\n") ? unified.slice(0, -1) : unified;
}
