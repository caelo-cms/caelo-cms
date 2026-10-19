// SPDX-License-Identifier: MPL-2.0

/**
 * Keep an HTML fragment from closing a `<template>` it is placed inside.
 *
 * The composer parks a consent-withheld module inside an inert
 * `<template data-caelo-deferred-content>` (#450). In the HTML parser the
 * only thing that ends a template from within is a `</template>` end tag,
 * so a fragment with an unmatched one would put the rest of the module
 * live on the page before the visitor consents. Balanced nested templates
 * are legitimate markup and must survive, which rules out escaping every
 * `</template`.
 *
 * This walks the fragment the way the HTML tokenizer does where it matters:
 * comments and raw-text elements (`<script>`, `<style>`, `<textarea>`, ...)
 * are skipped because a `</template` inside them is text, and attribute
 * values are skipped so a `<template` spelled inside one is not counted as
 * an open template. An unmatched `</template` becomes `&lt;/template` (the
 * same characters when shown as text); templates the fragment leaves open
 * are closed at its end so the wrapper's own `</template>` closes the
 * wrapper.
 */

/** Elements whose content the tokenizer reads as text until their end tag. */
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

/** Neutralize unmatched `</template>` closes and close templates left open. */
export function balanceTemplateCloses(html: string): string {
  let out = "";
  let depth = 0;
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
      out += html.slice(lt, end);
      i = end;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      // Doctype / bogus comment: text up to the next `>`.
      const end = html.indexOf(">", lt);
      const stop = end === -1 ? html.length : end + 1;
      out += html.slice(lt, stop);
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
    while (nameEnd < html.length && !/[\s/>]/.test(html[nameEnd] ?? "")) nameEnd++;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const tagEnd = tagClose(html, nameEnd);
    const tag = html.slice(lt, tagEnd);
    i = tagEnd;
    if (isEnd) {
      if (name === "template") {
        if (depth > 0) {
          depth--;
          out += tag;
        } else {
          out += `&lt;${tag.slice(1)}`;
        }
      } else {
        out += tag;
      }
      continue;
    }
    out += tag;
    if (name === "template") {
      depth++;
    } else if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = rawTextEnd(html, tagEnd, name);
      out += html.slice(tagEnd, close);
      i = close;
    }
  }
  return out + "</template>".repeat(depth);
}

/** Index just past the comment that started before `from` (`-->` or `--!>`), or the end. */
function commentEnd(html: string, from: number): number {
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
      while (i < html.length && /\s/.test(html[i] ?? "")) i++;
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
  const lower = html.toLowerCase();
  let at = lower.indexOf(`</${name}`, from);
  while (at !== -1) {
    const next = html[at + 2 + name.length];
    if (next === undefined || /[\s/>]/.test(next)) return at;
    at = lower.indexOf(`</${name}`, at + 1);
  }
  return html.length;
}
