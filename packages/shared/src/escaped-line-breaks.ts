// SPDX-License-Identifier: MPL-2.0

/**
 * Source text whose line breaks arrived string-escaped as a whole.
 *
 * e2e-livedit run 40532297620 (release gate v0.11.1): `add_module`'s html,
 * css and js came in with every line break as the two characters `\` `n`
 * (`(function () {\n  document…`). Stored as sent, the footer showed `\n`
 * text, its CSS broke, and the page's shared module `<script>` threw
 * `SyntaxError: Invalid or unexpected token` — a backslash outside a string
 * is not JavaScript. Like the other whole-value transport encodings
 * (`source-text-transport.ts`) the AI tool boundary decodes it, once.
 *
 * The same two characters are legitimate inside a string literal (`"a\nb"`
 * in JS or a CSS `content`), a regex, an HTML attribute value, or the body
 * of a raw-text element. A value is only decoded when EVERY escaped line
 * break sits where a real line break could have stood — between tokens of
 * code, or in markup text between tags. One escape inside a literal makes
 * the value ambiguous and it is left exactly as sent: decoding it would
 * turn valid source into broken source (a raw newline inside a JS string
 * is a syntax error). The op validators still refuse what is left broken
 * (module js is parsed in admin-core `module-js-syntax.ts`).
 */

/** Which grammar a source value is written in; decides what counts as a literal. */
export type SourceLanguage = "html" | "css" | "js";

/** `\n` or `\r\n` escape starting at `i` (a single backslash, not an escaped one). */
function escapedLineBreakLength(value: string, i: number): number {
  if (value[i] !== "\\") return 0;
  if (value[i + 1] === "n") return 2;
  if (value[i + 1] === "r" && value[i + 2] === "\\" && value[i + 3] === "n") return 4;
  return 0;
}

/** Characters after which a `/` in JS starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

/**
 * Index just past a quoted literal starting at `start` (its quote char), or
 * -1 when an escaped line break sits inside it.
 */
function skipQuoted(value: string, start: number): number {
  const quote = value[start];
  let j = start + 1;
  while (j < value.length) {
    const ch = value[j];
    if (ch === "\\") {
      if (value[j + 1] === "n" || value[j + 1] === "r") return -1;
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    j += 1;
  }
  return j;
}

/** True when an escaped line break sits inside a JS string, template, or regex literal. */
function jsLiteralHoldsEscape(value: string): boolean {
  let prev = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i] as string;
    const lineBreak = escapedLineBreakLength(value, i);
    if (lineBreak > 0) {
      prev = "";
      i += lineBreak;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipQuoted(value, i);
      if (end < 0) return true;
      prev = ch;
      i = end;
      continue;
    }
    if (ch === "/" && value[i + 1] === "/") {
      // A line comment runs to the next (escaped) line break.
      i += 2;
      while (i < value.length && escapedLineBreakLength(value, i) === 0) i += 1;
      continue;
    }
    if (ch === "/" && value[i + 1] === "*") {
      const close = value.indexOf("*/", i + 2);
      i = close < 0 ? value.length : close + 2;
      continue;
    }
    if (ch === "/" && (prev === "" || REGEX_PRECEDERS.has(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < value.length) {
        const r = value[j];
        if (r === "\\") {
          if (value[j + 1] === "n" || value[j + 1] === "r") return true;
          j += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        j += 1;
      }
      prev = "/";
      i = j + 1;
      continue;
    }
    if (ch !== " " && ch !== "\t") prev = ch;
    i += 1;
  }
  return false;
}

/** True when an escaped line break sits inside a CSS string. */
function cssLiteralHoldsEscape(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "/" && value[i + 1] === "*") {
      const close = value.indexOf("*/", i + 2);
      i = close < 0 ? value.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(value, i);
      if (end < 0) return true;
      i = end;
      continue;
    }
    i += ch === "\\" ? 2 : 1;
  }
  return false;
}

/** Elements whose body is not markup text: an escape there belongs to that body. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "pre", "textarea"]);

/** True when an escaped line break sits inside an attribute value, a comment, or a raw-text element body. */
function htmlLiteralHoldsEscape(value: string): boolean {
  const lower = value.toLowerCase();
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "<") {
      i += 1;
      continue;
    }
    if (value.startsWith("<!--", i)) {
      const close = value.indexOf("-->", i + 4);
      const end = close < 0 ? value.length : close + 3;
      if (/(?<!\\)\\[nr]/.test(value.slice(i, end))) return true;
      i = end;
      continue;
    }
    const name = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(value.slice(i, i + 64))?.[1]?.toLowerCase();
    let j = i + 1;
    while (j < value.length && value[j] !== ">") {
      if (value[j] === '"' || value[j] === "'") {
        const end = skipQuoted(value, j);
        if (end < 0) return true;
        j = end;
        continue;
      }
      j += 1;
    }
    i = j + 1;
    if (name && RAW_TEXT_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      const end = close < 0 ? value.length : close;
      if (/(?<!\\)\\[nr]/.test(value.slice(i, end))) return true;
      i = end;
    }
  }
  return false;
}

const LITERAL_HOLDS_ESCAPE: Readonly<Record<SourceLanguage, (value: string) => boolean>> = {
  html: htmlLiteralHoldsEscape,
  css: cssLiteralHoldsEscape,
  js: jsLiteralHoldsEscape,
};

/** An escaped line break (`\n`, `\r\n`) not preceded by another backslash. */
const ESCAPED_LINE_BREAK = /(?<!\\)(?:\\r)?\\n/g;

/**
 * True when a source value's line breaks were string-escaped as a whole:
 * no real line break at all, at least two escaped ones, one of them
 * followed by indentation (the signature of pretty-printed source), and
 * none inside a literal of `language` (see the file comment).
 *
 * @param value - the source text as sent.
 * @param language - the grammar the value is written in.
 */
export function hasEscapedLineBreaks(value: string, language: SourceLanguage): boolean {
  if (/[\r\n]/.test(value)) return false;
  const hits = value.match(ESCAPED_LINE_BREAK)?.length ?? 0;
  if (hits < 2) return false;
  if (!/(?<!\\)\\n(?:[ \t]|\\t)/.test(value)) return false;
  return !LITERAL_HOLDS_ESCAPE[language](value);
}

/**
 * The value with every escaped line break turned back into a real one (and
 * the escaped tabs indenting the next line into real tabs) when
 * `hasEscapedLineBreaks` holds; the input unchanged otherwise. Nothing else
 * is unescaped: quotes and backslashes arrived as they were meant.
 *
 * @param value - the tool argument (non-strings pass through).
 * @param language - the grammar the value is written in.
 */
export function decodeEscapedLineBreaks(value: unknown, language: SourceLanguage): unknown {
  if (typeof value !== "string" || !hasEscapedLineBreaks(value, language)) return value;
  return value.replace(
    /(?<!\\)(?:\\r)?\\n((?:\\t)*)/g,
    (_m, tabs: string) => `\n${"\t".repeat(tabs.length / 2)}`,
  );
}
