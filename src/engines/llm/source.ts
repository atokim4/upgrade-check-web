/**
 * A small lexer for Python and JavaScript/TypeScript: it marks which characters are
 * code, string or comment, so the rules can look at real call arguments without a
 * full parser (and without any runtime dependency).
 */

export type Language = "py" | "js";

export const CODE = 0;
export const STRING = 1;
export const COMMENT = 2;

export interface StringLiteral {
  /** Index of the opening quote. */
  start: number;
  /** Index just after the closing quote. */
  end: number;
  /** The text between the quotes (escapes left as written). */
  value: string;
  quote: string;
  /** Python triple-quoted string or a JS template literal that spans lines: prose, not config. */
  block: boolean;
}

export interface Source {
  text: string;
  language: Language;
  /** One of CODE / STRING / COMMENT per character. */
  mask: Uint8Array;
  strings: StringLiteral[];
}

const REGEX_PREFIX = /[(,=:[!&|?{};+\-*%<>~^]\s*$|(?:^|[^\w$])(?:return|typeof|case|do|else|in|of)\s*$|^\s*$/;

export function lex(text: string, language: Language): Source {
  const mask = new Uint8Array(text.length);
  const strings: StringLiteral[] = [];
  let i = 0;

  const markComment = (from: number, to: number) => mask.fill(COMMENT, from, to);

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (language === "py" && ch === "#") {
      const end = lineEnd(text, i);
      markComment(i, end);
      i = end;
      continue;
    }
    if (language === "js" && ch === "/" && next === "/") {
      const end = lineEnd(text, i);
      markComment(i, end);
      i = end;
      continue;
    }
    if (language === "js" && ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      markComment(i, end);
      i = end;
      continue;
    }
    if (language === "js" && ch === "/" && looksLikeRegex(text, i)) {
      const end = regexEnd(text, i);
      mask.fill(STRING, i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || (language === "js" && ch === "`")) {
      const triple = language === "py" && text.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      const end = stringEnd(text, i, quote, language);
      const value = text.slice(i + quote.length, Math.max(i + quote.length, end - quote.length));
      strings.push({ start: i, end, value, quote, block: triple || (ch === "`" && value.includes("\n")) });
      mask.fill(STRING, i, end);
      i = end;
      continue;
    }
    i += 1;
  }

  return { text, language, mask, strings };
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end;
}

function stringEnd(text: string, start: number, quote: string, language: Language): number {
  let i = start + quote.length;
  const singleLine = quote.length === 1 && quote !== "`";
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (singleLine && ch === "\n") return i; // unterminated: stop at the line end
    if (text.startsWith(quote, i)) return i + quote.length;
    if (quote === "`" && language === "js" && ch === "$" && text[i + 1] === "{") {
      i = skipTemplateExpression(text, i + 2);
      continue;
    }
    i += 1;
  }
  return text.length;
}

function skipTemplateExpression(text: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    const ch = text[i]!;
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === '"' || ch === "'" || ch === "`") {
      i = stringEnd(text, i, ch, "js");
      continue;
    }
    i += 1;
  }
  return i;
}

function looksLikeRegex(text: string, at: number): boolean {
  const next = text[at + 1];
  if (next === undefined || next === "/" || next === "*" || next === " " || next === "\n") return false;
  const before = text.slice(Math.max(0, at - 12), at);
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const sameLine = text.slice(lineStart, at);
  return REGEX_PREFIX.test(sameLine.length < before.length ? sameLine : before);
}

function regexEnd(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n") return start + 1; // not a regex after all: treat the slash as code
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i + 1;
    i += 1;
  }
  return start + 1;
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Index of the bracket that closes the one at `open`, or -1. */
export function matchingClose(src: Source, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < src.text.length; i += 1) {
    if (src.mask[i] !== CODE) continue;
    const ch = src.text[i]!;
    if (OPENERS[ch]) stack.push(OPENERS[ch]);
    else if (CLOSERS[ch]) {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Index of the nearest unclosed `(`, `[` or `{` before `at`, or -1. */
export function enclosingOpen(src: Source, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (src.mask[i] !== CODE) continue;
    const ch = src.text[i]!;
    if (CLOSERS[ch]) depth += 1;
    else if (OPENERS[ch]) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

export type KeyStyle = "kwarg" | "key" | "quoted" | "shorthand" | "spread" | "positional";

export interface Entry {
  /** First non-space character of the entry. */
  start: number;
  /** Just after the last non-space character of the entry. */
  end: number;
  key: string | null;
  style: KeyStyle;
  /** Quote used around a quoted key. */
  keyQuote?: string;
  /** Start of the key name itself (for renames). */
  keyStart?: number;
  valueStart: number;
}

const KWARG = /^([A-Za-z_]\w*)\s*=(?!=)/;
const KEY = /^([A-Za-z_$][\w$]*)\s*:/;
const QUOTED_KEY = /^(["'])([\w$-]+)\1\s*:/;
const SHORTHAND = /^[A-Za-z_$][\w$]*$/;

/** Splits the inside of the bracket pair (open, close) into top-level, comma-separated entries. */
export function entries(src: Source, open: number, close: number): Entry[] {
  const result: Entry[] = [];
  let depth = 0;
  let segmentStart = open + 1;

  const push = (from: number, to: number) => {
    let start = from;
    let end = to;
    while (start < end && isSkippable(src, start)) start += 1;
    while (end > start && isSkippable(src, end - 1)) end -= 1;
    if (start >= end) return;
    const raw = src.text.slice(start, end);
    result.push(parseEntry(src, raw, start, end));
  };

  for (let i = open + 1; i < close; i += 1) {
    if (src.mask[i] !== CODE) continue;
    const ch = src.text[i]!;
    if (OPENERS[ch]) depth += 1;
    else if (CLOSERS[ch]) depth -= 1;
    else if (ch === "," && depth === 0) {
      push(segmentStart, i);
      segmentStart = i + 1;
    }
  }
  push(segmentStart, close);
  return result;
}

function isSkippable(src: Source, i: number): boolean {
  return src.mask[i] === COMMENT || /\s/.test(src.text[i]!);
}

function parseEntry(src: Source, raw: string, start: number, end: number): Entry {
  if (raw.startsWith("**") || raw.startsWith("...")) {
    return { start, end, key: null, style: "spread", valueStart: start };
  }
  const quoted = QUOTED_KEY.exec(raw);
  if (quoted) {
    return {
      start, end, key: quoted[2]!, style: "quoted", keyQuote: quoted[1]!, keyStart: start + 1,
      valueStart: start + quoted[0].length,
    };
  }
  const kwarg = src.language === "py" ? KWARG.exec(raw) : null;
  if (kwarg) {
    return { start, end, key: kwarg[1]!, style: "kwarg", keyStart: start, valueStart: start + kwarg[0].length };
  }
  const key = src.language === "js" ? KEY.exec(raw) : null;
  if (key) return { start, end, key: key[1]!, style: "key", keyStart: start, valueStart: start + key[0].length };
  if (src.language === "js" && SHORTHAND.test(raw)) {
    return { start, end, key: raw, style: "shorthand", keyStart: start, valueStart: start };
  }
  return { start, end, key: null, style: "positional", valueStart: start };
}

/** 1-based line number of a character index. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The indentation (spaces/tabs) of the line that holds `index`. */
export function indentOf(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

