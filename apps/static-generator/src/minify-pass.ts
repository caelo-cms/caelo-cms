// SPDX-License-Identifier: MPL-2.0

/**
 * issue #158 — deploy-time minification of the page's inline CSS and JS.
 *
 * The composer emits readable CSS/JS (`<style data-source="…">`,
 * `<script defer data-source="modules">`) because the admin preview is
 * where people read them. Visitors only download them, so the static
 * build minifies exactly those composer-owned elements as its last pass
 * before writing — after the media, SEO and plugin passes, which still
 * rewrite URLs inside the CSS. Plugin-contributed tags and withheld
 * modules' parked scripts are left alone: they are not ours to rewrite.
 *
 * This is the one deliberate divergence between the preview and the
 * deployed page: same composer output, then whitespace / syntax
 * minification here. The byte-parity invariant (ARCHITECTURE.md) holds
 * up to this pass.
 *
 * Why esbuild for both: it keeps a script's semantics as a classic
 * script (directive prologues like `"use strict"` survive, top-level
 * names are never renamed because other modules' JS may read them), and
 * it never turns an escaped `<\/style` / `<\/script` back into the
 * sequence that would end the element. Bun's transpiler (drops
 * function-level `"use strict"`, unescapes `<\/script>`) and
 * lightningcss (unescapes `<\/style>`) both failed those probes. Invalid
 * CSS is passed through verbatim by esbuild, so the browser drops
 * exactly what it dropped before.
 */

import { escapeStyleText, scriptNeedsEncoding } from "@caelo-cms/shared";
import { transformSync } from "esbuild";

/** The composer-owned style elements (see preview-compose.ts). */
const STYLE_RE =
  /(<style data-source="(?:fonts|theme|base|modules|module)">)([\s\S]*?)(<\/style>)/g;
/** The composer-owned page script (see preview-compose.ts). */
const SCRIPT_RE = /(<script defer data-source="modules">)([\s\S]*?)(<\/script>)/g;

/** A page the pass rewrites in place. */
export interface MinifiablePage {
  html: string;
  readonly pageSlug: string;
}

/**
 * Minify every page's composer-owned CSS and JS in place. Identical
 * bodies (the theme and base CSS on every page) are minified once.
 *
 * Throws when a page's module JS does not parse: the browser would
 * refuse the whole page script too, silently breaking every module's
 * behaviour on that page.
 */
export function minifyPageAssets(pages: readonly MinifiablePage[]): void {
  const cssCache = new Map<string, string>();
  const jsCache = new Map<string, string>();
  for (const page of pages) {
    page.html = page.html
      .replace(STYLE_RE, (_m, open: string, body: string, close: string) => {
        let out = cssCache.get(body);
        if (out === undefined) {
          out = minifyCss(body);
          cssCache.set(body, out);
        }
        return `${open}${out}${close}`;
      })
      .replace(SCRIPT_RE, (_m, open: string, body: string, close: string) => {
        let out = jsCache.get(body);
        if (out === undefined) {
          out = minifyJs(body, page.pageSlug);
          jsCache.set(body, out);
        }
        return `${open}${out}${close}`;
      });
  }
}

/** Minified CSS, still safe inside `<style>`. */
export function minifyCss(css: string): string {
  const { code } = transformSync(css, { loader: "css", minify: true, logLevel: "silent" });
  return escapeStyleText(code.trimEnd());
}

/** Minified classic-script JS, still safe inside `<script>`. */
export function minifyJs(js: string, pageSlug: string): string {
  let code: string;
  try {
    code = transformSync(js, { loader: "js", minify: true, logLevel: "silent" }).code.trimEnd();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `static-generator: page slug=${pageSlug}: the page's module JavaScript does not parse, so no module script on this page would run. Fix the module whose js contains the line below (edit_module or edit_content), then rebuild:\n${detail}`,
    );
  }
  // esbuild escapes `</script` in strings; a sequence it could not
  // escape (one already present in a regex literal or comment) would
  // end the element early, exactly as it did before minification.
  if (scriptNeedsEncoding(code) && !scriptNeedsEncoding(js)) {
    throw new Error(
      `static-generator: page slug=${pageSlug}: minifying the page's module JavaScript produced a "</script" or "<!--" sequence the source did not contain`,
    );
  }
  return code;
}
