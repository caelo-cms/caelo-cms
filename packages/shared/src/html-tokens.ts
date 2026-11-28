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
 * to raw text: the plugin checks refuse every element whose content is raw
 * text, so the prose they admit is read as the browser reads it. A core
 * value's check (#1748) asks for the switch a tree builder makes
 * ({@link HtmlTokenOptions.textElements}).
 *
 * Linear and flat: no recursion however deep the markup nests.
 */

import { type Token, Tokenizer, TokenizerMode } from "parse5";

/** One token: a start or end tag, a comment (a `<?…>` too), a doctype, or text. */
export type HtmlToken =
  | {
      readonly kind: "start";
      /** Lowercased, as the tokenizer reads it. */
      readonly name: string;
      /** `value` decoded; `source` the attribute as written (`name="…"`). */
      readonly attrs: readonly {
        readonly name: string;
        readonly value: string;
        readonly source: string;
      }[];
      readonly selfClosing: boolean;
      /** Offset of the `<`. */
      readonly start: number;
      /** Offset just past the tag's `>`. */
      readonly end: number;
    }
  | { readonly kind: "end"; readonly name: string; readonly start: number }
  | { readonly kind: "comment"; readonly data: string; readonly start: number }
  | { readonly kind: "doctype"; readonly start: number }
  | { readonly kind: "text"; readonly value: string };

/** How a tree builder switches the tokenizer after an HTML start tag ({@link HtmlTokenOptions.textElements}). */
const TEXT_STATES: Readonly<Record<string, (typeof TokenizerMode)[keyof typeof TokenizerMode]>> = {
  title: TokenizerMode.RCDATA,
  textarea: TokenizerMode.RCDATA,
  style: TokenizerMode.RAWTEXT,
  xmp: TokenizerMode.RAWTEXT,
  iframe: TokenizerMode.RAWTEXT,
  noembed: TokenizerMode.RAWTEXT,
  noframes: TokenizerMode.RAWTEXT,
  // Scripting on, as in a browser.
  noscript: TokenizerMode.RAWTEXT,
  script: TokenizerMode.SCRIPT_DATA,
  plaintext: TokenizerMode.PLAINTEXT,
};

/** SVG and MathML elements whose content is HTML again (the HTML standard's integration points). */
const INTEGRATION_POINTS: ReadonlySet<string> = new Set([
  "foreignobject",
  "desc",
  "title",
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
  "annotation-xml",
]);

/** Options of {@link htmlTokens}. */
export interface HtmlTokenOptions {
  /**
   * #1748 — read the content of `<script>`, `<style>`, `<textarea>`,
   * `<title>` and the other text elements as text, as a browser's tree
   * builder makes its tokenizer read it in HTML content (outside SVG and
   * MathML): a core value's own balanced `<textarea></div></textarea>` is
   * no `</div>`. Off for the plugin checks, which refuse those elements.
   */
  readonly textElements?: boolean;
}

/** The tokens of `html`, in order. A tag left unfinished at the end is no token (the tokenizer drops it). */
export function htmlTokens(html: string, options: HtmlTokenOptions = {}): HtmlToken[] {
  const out: HtmlToken[] = [];
  // The SVG / MathML elements open around the current token, and the HTML
  // integration points among them (`foreignObject`, `mtext`, …), where
  // HTML, text elements included, is read again.
  const foreign: { readonly name: string; readonly html: boolean }[] = [];
  const inHtml = () =>
    foreign.length === 0 || (foreign[foreign.length - 1] as { html: boolean }).html;
  const text = (t: Token.CharacterToken) => {
    const last = out[out.length - 1];
    if (last?.kind === "text") out[out.length - 1] = { kind: "text", value: last.value + t.chars };
    else out.push({ kind: "text", value: t.chars });
  };
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onStartTag(t) {
        if (options.textElements) {
          if (inHtml()) {
            const textState = TEXT_STATES[t.tagName];
            if (textState !== undefined) tokenizer.state = textState;
            else if ((t.tagName === "svg" || t.tagName === "math") && !t.selfClosing) {
              foreign.push({ name: t.tagName, html: false });
            }
          } else if (!t.selfClosing) {
            foreign.push({ name: t.tagName, html: INTEGRATION_POINTS.has(t.tagName) });
          }
        }
        out.push({
          kind: "start",
          name: t.tagName,
          attrs: t.attrs.map((a) => {
            const at = t.location?.attrs?.[a.name];
            return {
              name: a.name,
              value: a.value,
              source: at ? html.slice(at.startOffset, at.endOffset) : "",
            };
          }),
          selfClosing: t.selfClosing,
          start: t.location?.startOffset ?? -1,
          end: t.location?.endOffset ?? -1,
        });
      },
      onEndTag(t) {
        if (options.textElements && foreign[foreign.length - 1]?.name === t.tagName) foreign.pop();
        out.push({ kind: "end", name: t.tagName, start: t.location?.startOffset ?? -1 });
      },
      onComment(t) {
        out.push({ kind: "comment", data: t.data, start: t.location?.startOffset ?? -1 });
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
