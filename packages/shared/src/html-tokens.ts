// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the tokens of a piece of markup as the HTML standard's tokenizer
 * reads it (parse5), for the checks that decide whether a plugin's markup
 * may reach a page (a richtext's prose check, a deferral placeholder).
 *
 * Tokens, not a tree: a tree builder drops what it cannot place where it
 * parses (a `<td>` outside a table, a `<body>` inside one), but the page
 * places the markup elsewhere, and there the dropped tag is an element
 * (the #1732 review ran `<td onfocus=…>` from a richtext inside a table).
 * Every start and end tag is seen, whatever a tree builder would do with
 * it. The tokenizer stays in its data state, as no tree builder switches it
 * to raw text: the checks refuse every element whose content is raw text,
 * so the prose they admit is read as the browser reads it.
 *
 * Linear and flat: no recursion however deep the markup nests.
 */

import { type Token, Tokenizer } from "parse5";

/** One token: a start or end tag, a comment (a `<?…>` too), a doctype, or text. */
export type HtmlToken =
  | {
      readonly kind: "start";
      /** Lowercased, as the tokenizer reads it. */
      readonly name: string;
      readonly attrs: readonly { readonly name: string; readonly value: string }[];
      readonly selfClosing: boolean;
      /** Offset of the `<`. */
      readonly start: number;
    }
  | { readonly kind: "end"; readonly name: string; readonly start: number }
  | { readonly kind: "comment"; readonly start: number }
  | { readonly kind: "doctype"; readonly start: number }
  | { readonly kind: "text"; readonly value: string };

/** The tokens of `html`, in order. A tag left unfinished at the end is no token (the tokenizer drops it). */
export function htmlTokens(html: string): HtmlToken[] {
  const out: HtmlToken[] = [];
  const text = (t: Token.CharacterToken) => {
    const last = out[out.length - 1];
    if (last?.kind === "text") out[out.length - 1] = { kind: "text", value: last.value + t.chars };
    else out.push({ kind: "text", value: t.chars });
  };
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onStartTag(t) {
        out.push({
          kind: "start",
          name: t.tagName,
          attrs: t.attrs.map((a) => ({ name: a.name, value: a.value })),
          selfClosing: t.selfClosing,
          start: t.location?.startOffset ?? -1,
        });
      },
      onEndTag(t) {
        out.push({ kind: "end", name: t.tagName, start: t.location?.startOffset ?? -1 });
      },
      onComment(t) {
        out.push({ kind: "comment", start: t.location?.startOffset ?? -1 });
      },
      onDoctype(t) {
        out.push({ kind: "doctype", start: t.location?.startOffset ?? -1 });
      },
      onCharacter: text,
      onNullCharacter: text,
      onWhitespaceCharacter: text,
      onEof() {},
    },
  );
  tokenizer.write(html, true);
  return out;
}
