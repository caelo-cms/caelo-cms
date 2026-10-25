// SPDX-License-Identifier: MPL-2.0

/**
 * Rendered module HTML → the plain text a visitor reads, for the AI's
 * SEO reads (`pages_seo.get_many`). A meta description is written from
 * a page's words, not its markup: the composed page (layout, theme, CSS)
 * is 50–200 KB, the text of its own content a few hundred words.
 *
 * Text only: tags dropped, entities decoded (the parser does it), script /
 * style / template bodies and comments skipped, whitespace collapsed. Each
 * block-level element (heading, paragraph, list item, …) ends a line, so
 * the AI still sees where one heading or card stops and the next begins.
 */

import { idSafeCutIndex } from "@caelo-cms/shared";
import { Parser } from "htmlparser2";

/** Elements whose body is never visible text. */
const SKIPPED = new Set(["script", "style", "template", "noscript", "svg", "head", "title"]);

/** Elements that end a line of text (block-level or a hard break). */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

/**
 * The visible text of an HTML fragment, one line per block element.
 *
 * @example
 * htmlToPlainText("<h1>Hi &amp; welcome</h1><p>Read <a href='/x'>more</a></p>");
 * // → "Hi & welcome\nRead more"
 */
export function htmlToPlainText(html: string): string {
  const lines: string[] = [];
  let current = "";
  let skipDepth = 0;
  const endLine = () => {
    const line = current.replace(/\s+/g, " ").trim();
    if (line.length > 0) lines.push(line);
    current = "";
  };
  const parser = new Parser(
    {
      onopentag(name) {
        // Inside a skipped element every tag counts, so its close tag
        // (the parser closes unclosed children with it) ends the skip.
        if (skipDepth > 0 || SKIPPED.has(name)) {
          skipDepth += 1;
          return;
        }
        if (BLOCK.has(name)) endLine();
      },
      onclosetag(name) {
        if (skipDepth > 0) {
          skipDepth -= 1;
          return;
        }
        if (BLOCK.has(name)) endLine();
      },
      ontext(text) {
        if (skipDepth === 0) current += text;
      },
    },
    { lowerCaseTags: true, decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  endLine();
  return lines.join("\n");
}

/** A text cut to a budget, and whether anything was cut. */
export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * `text` cut to at most `max` characters at a word boundary (the `…` mark
 * included), so a word, a URL or an id is shown whole or not at all.
 * Unchanged when it fits.
 */
export function capPlainText(text: string, max: number): CappedText {
  if (text.length <= max) return { text, truncated: false };
  const budget = Math.max(0, max - 1);
  // The last whitespace inside the budget: everything before it is whole words.
  let cut = -1;
  for (let i = budget; i > 0; i -= 1) {
    if (/\s/.test(text.charAt(i))) {
      cut = i;
      break;
    }
  }
  // One unbroken run longer than the budget (no whitespace at all): never
  // split an id inside it at least.
  if (cut <= 0) cut = idSafeCutIndex(text, budget);
  return { text: `${text.slice(0, cut).trimEnd()}…`, truncated: true };
}
