// SPDX-License-Identifier: MPL-2.0

/**
 * Decoding of whole-value transport encodings around AI tool arguments that
 * carry source text (module / template / layout html, css, js).
 *
 * The model sometimes encodes a long markup string as a whole before it
 * sends it: as a CDATA section (`unwrapCdataEnvelope`), as a JSON string
 * literal (`"<footer class=\"x\">…"`), or HTML-escaped (`&lt;main&gt;…`).
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

/** Every whole-value transport encoding, outermost first. */
export function decodeSourceTextTransport(value: unknown): unknown {
  return decodeHtmlEscapedSource(decodeJsonEncodedSource(unwrapCdataEnvelope(value)));
}
