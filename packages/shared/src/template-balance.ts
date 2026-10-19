// SPDX-License-Identifier: MPL-2.0

/**
 * Keep an HTML fragment from closing a `<template>` it is placed inside.
 *
 * The composer parks a consent-withheld module inside an inert
 * `<template data-caelo-deferred-content>` (#450). In the HTML parser the
 * only thing that ends a template from within is a `</template` end tag
 * (an ASCII-case-insensitive literal; tag names never decode character
 * references), so a fragment with an unmatched one would put the rest of
 * the module live on the page before the visitor consents. Balanced nested
 * templates are legitimate markup and must survive, which rules out
 * escaping every `</template`.
 *
 * The walk is FAIL-CLOSED: it does not have to agree with the browser's
 * tokenizer and tree builder everywhere, only in one direction. Every
 * `</template` it does not keep as the close of a template it counted is
 * rewritten — inside tags, attribute values, comments and raw text too,
 * because those are exactly the places where a hand-written walk and the
 * HTML parser can disagree (abrupt comments like `<!-->`, raw-text
 * elements that are ordinary elements in SVG/MathML, ...). A template is
 * only counted where it is certainly an HTML `<template>`: never inside
 * `<svg>` / `<math>`, where the tree builder can pop a foreign `template`
 * element implicitly (e.g. by `</svg>`) and a following `</template>`
 * would then close the wrapper. When the walk and the browser disagree,
 * the worst outcome is a template that stays open and keeps the rest of
 * the page inert — never withheld content running before consent.
 *
 * Rewrites: `&lt;/template` in markup, attribute values and comments (the
 * same characters once decoded or shown); `<\/template` in `<script>` /
 * `<style>` text (the same string in JS and CSS). Templates the fragment
 * leaves open are closed at its end so the wrapper's own `</template>`
 * closes the wrapper.
 */

/** Elements whose content the HTML tokenizer reads as text until their end tag. */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

/** Raw-text elements whose content is JS or CSS, where `<\/` keeps the meaning. */
const CODE_ELEMENTS = new Set(["script", "style"]);

/** Roots of foreign (SVG / MathML) content. */
const FOREIGN_ROOTS = new Set(["svg", "math"]);

/** The HTML tokenizer's whitespace (not JS `\s`, which also matches U+00A0 etc.). */
const HTML_WS = /[\t\n\f\r ]/;

/** A tag name ends at HTML whitespace, `/` or `>`. */
const TAG_NAME_END = /[\t\n\f\r />]/;

const TEMPLATE_CLOSE_RE = /<\/template/gi;

/** Neutralize every `</template` in markup / attribute / comment text. */
function neutralizeMarkup(s: string): string {
  return s.replace(TEMPLATE_CLOSE_RE, (m) => `&lt;${m.slice(1)}`);
}

/** Neutralize every `</template` in JS / CSS text. */
function neutralizeCode(s: string): string {
  return s.replace(TEMPLATE_CLOSE_RE, (m) => `<\\${m.slice(1)}`);
}

/**
 * Rewrite `<!--` in script text to `<\!--`. A `<!--` puts the HTML
 * tokenizer's script data into its escaped states, where a nested
 * `<script` makes the next `</script>` NOT end the element — the browser's
 * script would then run past the end this walk found. Without `<!--` both
 * agree. `\!` is `!` in JS strings and non-unicode regexes.
 */
function neutralizeScriptEscapes(s: string): string {
  return s.replaceAll("<!--", () => "<\\!--");
}

/** ASCII-only lowercase: same length as the input, like the HTML tokenizer. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Neutralize unmatched `</template>` closes and close templates left open. */
export function balanceTemplateCloses(html: string): string {
  let out = "";
  let depth = 0;
  let foreignDepth = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = commentEnd(html, lt + 4);
      out += neutralizeMarkup(html.slice(lt, end));
      i = end;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      // Doctype / CDATA / bogus comment: text up to the next `>`.
      const end = html.indexOf(">", lt);
      const stop = end === -1 ? html.length : end + 1;
      out += neutralizeMarkup(html.slice(lt, stop));
      i = stop;
      continue;
    }
    const isEnd = html[lt + 1] === "/";
    const nameStart = lt + (isEnd ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
      // Not a tag (`a < b`, `</ >`): the `<` is text.
      out += "<";
      i = lt + 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < html.length && !TAG_NAME_END.test(html[nameEnd] ?? "")) nameEnd++;
    const name = asciiLower(html.slice(nameStart, nameEnd));
    const tagEnd = tagClose(html, nameEnd);
    const tag = html.slice(lt, tagEnd);
    const selfClosing = tag.endsWith("/>");
    i = tagEnd;
    if (isEnd) {
      if (name === "template" && depth > 0 && foreignDepth === 0) {
        depth--;
        out += `</template${neutralizeMarkup(tag.slice("</template".length))}`;
        continue;
      }
      if (FOREIGN_ROOTS.has(name) && foreignDepth > 0) foreignDepth--;
      out += neutralizeMarkup(tag);
      continue;
    }
    out += neutralizeMarkup(tag);
    if (foreignDepth > 0) {
      // Foreign content: no raw-text elements, no HTML templates counted.
      if (FOREIGN_ROOTS.has(name) && !selfClosing) foreignDepth++;
      continue;
    }
    if (name === "template") {
      depth++;
    } else if (FOREIGN_ROOTS.has(name)) {
      if (!selfClosing) foreignDepth++;
    } else if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = rawTextEnd(html, tagEnd, name);
      const body = html.slice(tagEnd, close);
      out +=
        name === "script"
          ? neutralizeScriptEscapes(neutralizeCode(body))
          : CODE_ELEMENTS.has(name)
            ? neutralizeCode(body)
            : neutralizeMarkup(body);
      i = close;
    }
  }
  return out + "</template>".repeat(depth);
}

/**
 * Index just past the comment whose `<!--` ends at `from`. Per the HTML
 * tokenizer `<!-->` and `<!--->` are complete (empty) comments; otherwise
 * the comment ends at `-->` or `--!>`, or at the end of input.
 */
function commentEnd(html: string, from: number): number {
  if (html[from] === ">") return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  const m = /--!?>/g;
  m.lastIndex = from;
  const hit = m.exec(html);
  return hit === null ? html.length : hit.index + hit[0].length;
}

/**
 * Index just past the `>` that ends the tag whose name ends at `from`.
 * Quoted attribute values may hold `>`; they are only quotes after `=`.
 */
function tagClose(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const ch = html[i];
    if (ch === ">") return i + 1;
    if (ch === "=") {
      i++;
      while (i < html.length && HTML_WS.test(html[i] ?? "")) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1) return html.length;
        i = close + 1;
        continue;
      }
      continue;
    }
    i++;
  }
  return html.length;
}

/** Index where the raw-text element `name`'s end tag starts, or the end. */
function rawTextEnd(html: string, from: number, name: string): number {
  const lower = asciiLower(html);
  let at = lower.indexOf(`</${name}`, from);
  while (at !== -1) {
    const next = html[at + 2 + name.length];
    if (next === undefined || TAG_NAME_END.test(next)) return at;
    at = lower.indexOf(`</${name}`, at + 1);
  }
  return html.length;
}
