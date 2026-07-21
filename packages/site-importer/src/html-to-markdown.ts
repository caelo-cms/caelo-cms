// SPDX-License-Identifier: MPL-2.0

/**
 * Focused HTML → Markdown for the `inspect_external_page` gist facet.
 *
 * The AI needs the *readable text + light structure* of a page to
 * understand what it's about and how it's laid out — NOT pixel-perfect
 * Markdown. So this is a pragmatic converter over the streaming
 * `htmlparser2` (already a dependency), not a full DOM round-trip: no
 * jsdom/linkedom/turndown added to the tree. It handles the tags that
 * carry meaning for understanding — headings, paragraphs, links, lists,
 * images (alt), emphasis, code, blockquote, rules — and drops the rest
 * (script/style/svg/etc. subtrees, all attributes).
 *
 * Deliberately NOT handled richly: tables (rows become lines), deeply
 * nested inline formatting edge cases. Good enough for "understand the
 * page"; structure-precise extraction is `query_page_html`'s job.
 */

import { Parser } from "htmlparser2";

/** Subtrees whose text is noise for understanding — skipped wholesale. */
const SKIP_SUBTREE = new Set([
  "script",
  "style",
  "head",
  "noscript",
  "svg",
  "template",
  "iframe",
  "object",
  "embed",
  "canvas",
]);

const HEADING_PREFIX = new Map<string, string>([
  ["h1", "# "],
  ["h2", "## "],
  ["h3", "### "],
  ["h4", "#### "],
  ["h5", "##### "],
  ["h6", "###### "],
]);

/** Block-level tags that force a paragraph break around their content. */
const BLOCK_BREAK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "figure",
  "figcaption",
  "form",
  "table",
  "thead",
  "tbody",
  "tr",
]);

/**
 * Convert an HTML string to a readable Markdown approximation. Pure +
 * synchronous. Never throws on malformed HTML — htmlparser2 is lenient
 * and unmatched tags are unwound defensively.
 */
export function htmlToMarkdown(html: string): string {
  const parts: string[] = [];
  let skipDepth = 0;
  let preDepth = 0;
  // href captured at <a> open, consumed at </a> close (so inline
  // formatting inside the anchor survives). Single-level; nested <a> is
  // invalid HTML and not modelled.
  let currentHref = "";
  // Ordered/unordered list nesting; `index` counts <li> for ordered lists.
  const listStack: Array<{ ordered: boolean; index: number }> = [];

  const emit = (s: string): void => {
    parts.push(s);
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (SKIP_SUBTREE.has(tag)) {
          skipDepth += 1;
          return;
        }
        if (skipDepth > 0) return;

        const heading = HEADING_PREFIX.get(tag);
        if (heading) {
          emit(`\n\n${heading}`);
          return;
        }
        switch (tag) {
          case "br":
            emit("\n");
            return;
          case "hr":
            emit("\n\n---\n\n");
            return;
          case "a":
            currentHref = (attribs.href ?? "").trim();
            emit("[");
            return;
          case "strong":
          case "b":
            emit("**");
            return;
          case "em":
          case "i":
            emit("*");
            return;
          case "code":
            if (preDepth === 0) emit("`");
            return;
          case "pre":
            preDepth += 1;
            emit("\n\n```\n");
            return;
          case "blockquote":
            emit("\n\n> ");
            return;
          case "img": {
            const alt = (attribs.alt ?? "").trim();
            const src = (attribs.src ?? "").trim();
            if (alt || src) emit(`![${alt}](${src})`);
            return;
          }
          case "ul":
            listStack.push({ ordered: false, index: 0 });
            return;
          case "ol":
            listStack.push({ ordered: true, index: 0 });
            return;
          case "li": {
            const top = listStack[listStack.length - 1];
            const depth = Math.max(0, listStack.length - 1);
            const indent = "  ".repeat(depth);
            if (top?.ordered) {
              top.index += 1;
              emit(`\n${indent}${top.index}. `);
            } else {
              emit(`\n${indent}- `);
            }
            return;
          }
          default:
            if (BLOCK_BREAK.has(tag)) emit("\n\n");
            return;
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        if (preDepth > 0) {
          emit(text);
          return;
        }
        // Collapse runs of whitespace to a single space — the block-break
        // emits above carry the real structure.
        const collapsed = text.replace(/\s+/g, " ");
        if (collapsed.length > 0) emit(collapsed);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (SKIP_SUBTREE.has(tag)) {
          if (skipDepth > 0) skipDepth -= 1;
          return;
        }
        if (skipDepth > 0) return;

        if (HEADING_PREFIX.has(tag)) {
          emit("\n");
          return;
        }
        switch (tag) {
          case "a":
            emit(`](${currentHref})`);
            currentHref = "";
            return;
          case "strong":
          case "b":
            emit("**");
            return;
          case "em":
          case "i":
            emit("*");
            return;
          case "code":
            if (preDepth === 0) emit("`");
            return;
          case "pre":
            if (preDepth > 0) preDepth -= 1;
            emit("\n```\n\n");
            return;
          case "ul":
          case "ol":
            listStack.pop();
            emit("\n");
            return;
          default:
            if (BLOCK_BREAK.has(tag)) emit("\n\n");
            return;
        }
      },
    },
    { decodeEntities: true },
  );

  parser.write(html);
  parser.end();

  return normalizeMarkdown(parts.join(""));
}

/**
 * Trim, drop trailing spaces, and collapse 3+ blank lines to one.
 * Intentionally does NOT collapse runs of spaces: inline text is already
 * whitespace-collapsed at emit time, while list indentation and <pre>
 * content depend on their spaces surviving.
 *
 * Trailing-whitespace stripping is a per-line linear pass, NOT a `/[ \t]+\n/`
 * regex: that pattern's greedy `[ \t]+` rescans every start position on a long
 * space/tab run with no following newline, which is O(n^2) on adversarial input
 * (CodeQL js/polynomial-redos). The char-code loop below is O(n).
 */
function normalizeMarkdown(md: string): string {
  const lines = md.split("\n").map((line) => {
    let end = line.length;
    while (end > 0) {
      const code = line.charCodeAt(end - 1);
      if (code !== 0x20 && code !== 0x09) break; // space, tab
      end -= 1;
    }
    return end === line.length ? line : line.slice(0, end);
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
