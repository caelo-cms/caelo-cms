// SPDX-License-Identifier: MPL-2.0

/**
 * Write hints (core's `writeHintsOperation` hook, #1511): when the AI
 * writes a module that carries the comments placeholder, it hears in the
 * same tool result what the runtime will not be able to bind to — before
 * a visitor finds a form that does nothing.
 *
 * The checks follow the contract in `runtime.ts`. They read the module
 * markup as STORED, so `{{site_text.*}}` and `{{page.id}}` are still
 * template text here, which is what they check for. Markup is matched
 * with simple attribute scans, not parsed: the hints are advice to the
 * AI, and the runtime still warns on the rendered page.
 */

import type { PluginWrite } from "@caelo-cms/plugin-sdk";
import { COMMENTS_CONTRACT as C } from "./runtime.js";

const PLACEHOLDER_RE = /<div\b[^>]*\bdata-caelo-plugin\s*=\s*["']comments["'][^>]*>/i;
/** The exact opening the static generator's plugin pass matches (first attribute, then the page id). */
const PLACEHOLDER_SHAPE_RE =
  /<div\s+data-caelo-plugin="comments"[^>]*\bdata-page-id="([^"]*)"[^>]*>/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasAttr(html: string, attr: string): boolean {
  return new RegExp(`[\\s"']${attr}(?=[\\s=>/])`, "i").test(html);
}

function hasName(html: string, name: string): boolean {
  return new RegExp(`\\bname\\s*=\\s*["']${name}["']`, "i").test(html);
}

/** Attributes whose values a visitor reads or hears. */
const VISIBLE_ATTRS = ["aria-label", "placeholder", "title", "alt"];

/**
 * The visible texts of the markup that are written out rather than read
 * from a site text or a field: text runs between tags and the values of
 * {@link VISIBLE_ATTRS}. A linear scan over the markup, no backtracking.
 */
function literalTexts(html: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text !== "" && !text.includes("{{") && /\p{L}/u.test(text) && !out.includes(text)) {
      out.push(text);
    }
  };
  for (const part of html.split("<")) {
    const close = part.indexOf(">");
    if (close === -1) continue;
    const tag = part.slice(0, close);
    for (const name of VISIBLE_ATTRS) {
      const at = tag.indexOf(`${name}="`);
      if (at === -1 || !/[\s"']/.test(tag[at - 1] ?? "")) continue;
      const end = tag.indexOf('"', at + name.length + 2);
      if (end !== -1) add(tag.slice(at + name.length + 2, end));
    }
    if (!tag.startsWith("!--")) add(part.slice(close + 1));
  }
  return out;
}

/** The hints for one module's markup; empty when it carries no comments placeholder. */
export function commentsModuleHints(html: string): string[] {
  if (!PLACEHOLDER_RE.test(html)) return [];
  const out: string[] = [];

  const shape = PLACEHOLDER_SHAPE_RE.exec(html);
  if (!shape) {
    out.push(
      'Write the comments placeholder exactly as <div data-caelo-plugin="comments" data-page-id="{{page.id}}"></div> (data-caelo-plugin first, then data-page-id); in any other shape the build bakes no comments into it.',
    );
  } else {
    const pageId = shape[1] ?? "";
    if (UUID_RE.test(pageId)) {
      out.push(
        "The placeholder names one page by id, so this module only works on that page. Use data-page-id=\"{{page.id}}\": then ONE module serves every page it is placed on (place it with add_module target 'template' for all pages of a template, or in the layout for every page that uses it, pages created later included).",
      );
    } else if (pageId !== "{{page.id}}") {
      out.push('Set data-page-id="{{page.id}}" on the comments placeholder.');
    }
    const after = html.slice(shape.index + shape[0].length);
    const close = after.search(/<\/div>/i);
    const inner = close === -1 ? after : after.slice(0, close);
    if (close === -1 || /<div\b/i.test(inner)) {
      out.push(
        "Leave the comments placeholder empty and close it right away (<div …></div>): the build replaces it up to its first </div> with the baked comments.",
      );
    }
  }

  const missing: string[] = [];
  if (!hasAttr(html, C.section))
    missing.push(`a root element with ${C.section} around the placeholder and the form`);
  if (!/<form\b[^>]*\bdata-comment-form\b/i.test(html)) missing.push(`<form ${C.form}>`);
  if (!hasName(html, C.authorField)) missing.push(`a name field name="${C.authorField}"`);
  if (!hasName(html, C.contentField)) missing.push(`a comment field name="${C.contentField}"`);
  if (!/\btype\s*=\s*["']submit["']/i.test(html)) missing.push('a button type="submit"');
  if (!hasAttr(html, C.status)) missing.push(`an element with ${C.status} for the outcome`);
  if (!hasAttr(html, C.sent) || !hasAttr(html, C.error)) {
    missing.push(
      `the two messages inside it, <span ${C.sent} hidden>…</span> and <span ${C.error} hidden>…</span>`,
    );
  }
  if (!hasAttr(html, C.older))
    missing.push(`a button with ${C.older} hidden (shown while older comments exist)`);
  if (missing.length > 0) {
    out.push(
      `The comments module is missing ${missing.join("; ")}. Without them visitors cannot comment or page through the thread.`,
    );
  }

  // Two fields need two names: a <label> each, or an aria-label(ledby) on the field itself.
  const labels = (html.match(/<label\b/gi) ?? []).length;
  const namedFields = (html.match(/<(?:input|textarea)\b[^>]*\baria-label(?:ledby)?\s*=/gi) ?? [])
    .length;
  if (labels + namedFields < 2) {
    out.push(
      "Give the name and comment fields visible <label>s (a placeholder is no label: screen readers and autofill need one).",
    );
  }
  const literals = literalTexts(html);
  if (literals.length > 0) {
    const shown = literals
      .slice(0, 4)
      .map((t) => JSON.stringify(t))
      .join(", ");
    out.push(
      `Word every visible text with {{site_text.<key>}} (keys in the site-texts list, added with patch_list_items_many), never literal text: ${shown} would show in every language of the site as written.`,
    );
  }
  return out.slice(0, 5);
}

/** The hints for a batch of writes (core shows at most five). */
export function writeHints(writes: ReadonlyArray<PluginWrite>): string[] {
  const out: string[] = [];
  for (const w of writes) {
    if (w.kind !== "module") continue;
    for (const hint of commentsModuleHints(w.html)) if (!out.includes(hint)) out.push(hint);
  }
  return out.slice(0, 5);
}
