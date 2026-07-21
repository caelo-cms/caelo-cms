// SPDX-License-Identifier: MPL-2.0

/**
 * CDATA-guard normalization for module HTML.
 *
 * The AI sometimes authors chrome/layout module HTML with XHTML-style
 * CDATA guards wrapping inline `<style>`/`<script>` content — e.g.
 *
 *   <script>
 *   //<![CDATA[
 *     doStuff();
 *   //]]>
 *   </script>
 *
 * or the block-comment / bare forms (`/*<![CDATA[* /`, `<![CDATA[`).
 * These are legal in XHTML but MEANINGLESS in HTML5: the compose
 * pipeline is byte-preserving by design (see `preview-scanner.ts`), so
 * the guards survive verbatim into the rendered page. Chrome/layout
 * modules render straight from their stored HTML (no content_instance
 * indirection), so a bare `<![CDATA[` in the body is parsed by the
 * browser as a bogus comment up to the first `>`, leaving a stray,
 * visible `]]>` in the header/footer/nav.
 *
 * We normalize at the module-HTML write boundary (canonical) and again
 * defensively at render, so both freshly-authored and already-stored
 * modules stay clean. Only the DELIMITERS are removed — the wrapped
 * CSS/JS/markup content is preserved.
 *
 * This is normalization of malformed authored markup, not a data
 * fallback (CLAUDE.md §2): there is no "missing" data to point at, and
 * the inner content is kept intact.
 */

/**
 * Matches every CDATA-guard delimiter form the model emits. The
 * comment-wrapped variants come first so they're consumed as a unit
 * before the bare `<![CDATA[` / `]]>` alternatives can match a subset.
 */
const CDATA_GUARDS =
  /\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\/|\/\/[ \t]*<!\[CDATA\[|\/\/[ \t]*\]\]>|<!\[CDATA\[|\]\]>/g;

/**
 * Strip XHTML-style CDATA-section guard delimiters from module HTML,
 * preserving the content they wrapped. Returns the input unchanged when
 * no guard is present (fast path for the overwhelming clean-HTML case).
 */
export function stripCdataGuards(html: string): string {
  if (!html.includes("CDATA") && !html.includes("]]>")) return html;
  return html.replace(CDATA_GUARDS, "");
}
