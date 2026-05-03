// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — per-page extraction. Given fetched HTML, split into:
 *   - title (from <title>)
 *   - modules: header / 1..N body sections / footer
 *   - themeTokens: a small set of CSS custom properties + computed
 *     fonts/colors sampled from `:root` declarations in inline
 *     <style> blocks (best-effort — we don't run a full CSS engine)
 *
 * Heuristic + best-effort. Owner reviews + edits in /security/import.
 */

import { Parser } from "htmlparser2";

export interface ExtractedModule {
  readonly blockName: "header" | "content" | "footer";
  readonly position: number;
  readonly html: string;
  readonly displayName: string;
}

export interface ExtractedPage {
  readonly title: string;
  readonly modules: ReadonlyArray<ExtractedModule>;
  readonly themeTokens: Readonly<Record<string, string>>;
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return decodeEntities(m[1]?.trim() ?? "").slice(0, 200);
}

/**
 * Split a page into header / sections / footer modules.
 *
 * Strategy:
 *   1. Find <header>...</header> in the document body. If present →
 *      one header module.
 *   2. Find <footer>...</footer>. If present → one footer module.
 *   3. Body content between header + footer is split into modules at
 *      each top-level <section>, <article>, or <main> element. If no
 *      semantic markers exist → one big "content" module.
 *
 * Returns positions in render order so `page_modules` rows insert
 * cleanly when the Owner accepts.
 */
export function extractModulesFromHtml(html: string): ExtractedModule[] {
  const body = sliceBody(html);
  const modules: ExtractedModule[] = [];

  const header = sliceTagBlock(body, "header");
  if (header) {
    modules.push({
      blockName: "header",
      position: 0,
      html: header.html,
      displayName: "Header (imported)",
    });
  }

  const footer = sliceTagBlock(body, "footer");
  if (footer) {
    modules.push({
      blockName: "footer",
      position: 0,
      html: footer.html,
      displayName: "Footer (imported)",
    });
  }

  // Strip header + footer from the body before splitting content.
  let middle = body;
  if (header) middle = middle.replace(header.html, "");
  if (footer) middle = middle.replace(footer.html, "");

  // Pull each top-level <section> / <article> / <main> out as its
  // own module. If none, the whole middle becomes one content module.
  const sectionMatches = collectTopLevelTags(middle, ["section", "article", "main"]);
  if (sectionMatches.length > 0) {
    sectionMatches.forEach((m, i) => {
      modules.push({
        blockName: "content",
        position: i,
        html: m,
        displayName: `Section ${i + 1} (imported)`,
      });
    });
  } else {
    const trimmed = middle.trim();
    if (trimmed.length > 0) {
      modules.push({
        blockName: "content",
        position: 0,
        html: trimmed,
        displayName: "Body (imported)",
      });
    }
  }

  return modules;
}

/**
 * Sample theme tokens from inline <style> blocks. Looks for
 * :root { --name: value; ... } declarations. Cheap; doesn't run a
 * full CSS parser. The Owner refines tokens via /security/structured.
 */
export function extractThemeTokens(html: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  for (const block of styleBlocks) {
    const css = block[1] ?? "";
    const root = css.match(/:root\s*\{([\s\S]*?)\}/);
    if (!root) continue;
    const decls = root[1] ?? "";
    for (const line of decls.split(";")) {
      const m = line.match(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+?)\s*$/);
      if (m?.[1] && m?.[2]) {
        tokens[m[1]] = m[2].trim();
      }
    }
  }
  return tokens;
}

// ---- helpers ----------------------------------------------------------------

function sliceBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? (m[1] ?? "") : html;
}

interface TagBlock {
  html: string;
}

/** Slice the FIRST occurrence of `<tag>…</tag>` (at any depth). */
function sliceTagBlock(html: string, tag: string): TagBlock | null {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "i");
  const close = new RegExp(`</${tag}>`, "i");
  const o = open.exec(html);
  if (!o) return null;
  const c = close.exec(html.slice(o.index));
  if (!c) return null;
  const end = o.index + c.index + c[0].length;
  return { html: html.slice(o.index, end) };
}

/**
 * Walk html via htmlparser2; collect every TOP-LEVEL element matching
 * one of the requested tag names (depth=0 children of the body). Avoids
 * double-counting nested sections.
 */
function collectTopLevelTags(html: string, tagNames: string[]): string[] {
  const wanted = new Set(tagNames.map((t) => t.toLowerCase()));
  const collected: string[] = [];
  let depth = 0;
  let captureStart = -1;
  let captureName = "";
  let cursor = 0;
  // The parser doesn't give byte offsets directly in htmlparser2; we
  // approximate by re-scanning and accumulating a manual cursor in a
  // simple stream.
  const parser = new Parser({
    onopentag(name) {
      const lower = name.toLowerCase();
      if (depth === 0 && wanted.has(lower)) {
        captureStart = cursor;
        captureName = lower;
      }
      depth += 1;
    },
    onclosetag(name) {
      depth -= 1;
      if (depth === 0 && captureStart >= 0 && name.toLowerCase() === captureName) {
        // Re-derive the actual slice via regex from captureStart.
        const slice = sliceFromOpenAt(html, captureStart, captureName);
        if (slice) collected.push(slice);
        captureStart = -1;
        captureName = "";
      }
    },
    ontext(t) {
      cursor += t.length;
    },
  });
  parser.write(html);
  parser.end();
  return collected;
}

function sliceFromOpenAt(html: string, _hint: number, tag: string): string | null {
  // Simple search-and-balance from the first `<tag` after _hint chars.
  const re = new RegExp(`<${tag}\\b[^>]*>`, "ig");
  const m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    // Balance until matching close.
    let i = m.index + m[0].length;
    let stack = 1;
    const openRe = new RegExp(`<${tag}\\b`, "ig");
    const closeRe = new RegExp(`</${tag}>`, "ig");
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    while (stack > 0) {
      const o = openRe.exec(html);
      const c = closeRe.exec(html);
      if (!c) return null;
      if (o && o.index < c.index) {
        stack += 1;
        openRe.lastIndex = o.index + 1;
        closeRe.lastIndex = o.index + 1;
      } else {
        stack -= 1;
        i = c.index + c[0].length;
        openRe.lastIndex = i;
        closeRe.lastIndex = i;
      }
    }
    return html.slice(m.index, i);
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
