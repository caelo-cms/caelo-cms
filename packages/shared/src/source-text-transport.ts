// SPDX-License-Identifier: MPL-2.0

/**
 * Decoding of whole-value transport encodings around AI tool arguments that
 * carry source text (module / template / layout html, css, js).
 *
 * The model sometimes encodes a long markup string as a whole before it
 * sends it: as a CDATA section (`unwrapCdataEnvelope`), as a JSON string
 * literal (`"<footer class=\"x\">…"`), HTML-escaped (`&lt;main&gt;…`), or
 * with its line breaks string-escaped (`{\n  color: red;\n}`, see
 * `decodeEscapedLineBreaks`).
 * Each is an encoding of a value the caller did supply, never content:
 * a JSON string literal is not valid markup, CSS or JS as a whole, and
 * markup without a single `<` but with `&lt;tag` has no element at all.
 * Refusing them cost a tool round-trip each time (e2e-livedit runs of
 * PR #1121 and #1143); describing them in every tool cost tokens on every
 * call and still did not stop them. So the boundary decodes them, once,
 * here. Anything not clearly a whole-value encoding is left untouched and
 * the op validator still refuses it (shared `content.ts`), which also
 * keeps human and import writes strict. This is input normalisation, not
 * a fallback for missing data (CLAUDE.md §2).
 */

import { unwrapCdataEnvelope } from "./strip-cdata.js";

/**
 * The body of a whole-value JSON string literal, or the input unchanged.
 * Only decoded when the literal carries an escape (`\"`, `\n`, `\t`, `\\`,
 * `\/`, `\u…`): a bare `"use strict"` stays as it is.
 */
export function decodeJsonEncodedSource(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return value;
  if (!/\\["ntr\\/u]/.test(t)) return value;
  try {
    const decoded: unknown = JSON.parse(t);
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
};

/**
 * Markup sent HTML-escaped as a whole, decoded once; the input unchanged
 * otherwise. "As a whole" = no raw `<` anywhere and at least one escaped
 * tag (`&lt;div`, `&lt;/div`) — the same test the op's refusal uses.
 * `&amp;` is decoded last, so an entity the author meant (`&amp;nbsp;`
 * sent for `&nbsp;`) comes out as the author wrote it.
 */
export function decodeHtmlEscapedSource(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.includes("<") || !/&lt;\/?[a-zA-Z]/.test(value)) return value;
  return value
    .replace(/&lt;|&gt;|&quot;|&#34;|&#39;|&#x27;|&apos;/g, (e) => ENTITIES[e] ?? e)
    .replace(/&amp;/g, "&");
}

/**
 * A literal `\n` (backslash + `n`) not preceded by another backslash —
 * an escaped line break as opposed to an escaped backslash followed by `n`.
 */
const ESCAPED_LINE_BREAK = /(?<!\\)(?:\\r)?\\n/g;

/**
 * True when a source value's line breaks were string-escaped as a whole:
 * the value has no real line break at all, carries at least two literal
 * `\n` sequences, and at least one of them is followed by indentation (a
 * space or a tab, raw or escaped). That is the signature of pretty-printed
 * source (`(function () {\n  document…`) whose newlines arrived as the two
 * characters `\` `n` — e2e-livedit run 40532297620: the footer module's
 * html, css and js all came in that shape, the page showed literal `\n`
 * text and the shared module `<script>` threw `SyntaxError: Invalid or
 * unexpected token` (a backslash outside a string is not JavaScript).
 * Hand-written single-line source almost never matches: a minified script
 * has no indentation, and one `'\n'` in a string is below the threshold.
 */
export function hasEscapedLineBreaks(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const hits = value.match(ESCAPED_LINE_BREAK)?.length ?? 0;
  if (hits < 2) return false;
  return /(?<!\\)\\n(?:[ \t]|\\t)/.test(value);
}

/**
 * Source whose line breaks were string-escaped as a whole (see
 * `hasEscapedLineBreaks`), with every escaped line break turned back into a
 * real one and the escaped tabs that indent the next line into real tabs;
 * the input unchanged otherwise. Nothing else is unescaped: quotes and
 * backslashes arrived as they were meant.
 */
export function decodeEscapedLineBreaks(value: unknown): unknown {
  if (typeof value !== "string" || !hasEscapedLineBreaks(value)) return value;
  return value.replace(
    /(?<!\\)(?:\\r)?\\n((?:\\t)*)/g,
    (_m, tabs: string) => `\n${"\t".repeat(tabs.length / 2)}`,
  );
}

/** Every whole-value transport encoding, outermost first. */
export function decodeSourceTextTransport(value: unknown): unknown {
  return decodeEscapedLineBreaks(
    decodeHtmlEscapedSource(decodeJsonEncodedSource(unwrapCdataEnvelope(value))),
  );
}
