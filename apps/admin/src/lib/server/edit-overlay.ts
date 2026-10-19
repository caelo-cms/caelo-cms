// SPDX-License-Identifier: MPL-2.0

/**
 * Splices the live-edit overlay runtime (`INJECT_SCRIPT`) into a composed
 * preview page — shared by `/edit/preview/[pageId]` and
 * `/edit/preview-by-path/[...path]`, which serve that page from the ADMIN
 * origin inside the editor's iframe.
 *
 * Two things here are security-relevant (PR #863, M-08):
 *   - The page context lands inside a `<script>` element, where the HTML
 *     parser ends the element at the first `</script` — whatever JSON
 *     escaping does. Page slugs and paths come from operator / AI / import
 *     input, so every `<` is written as `<` (still the same JS string).
 *   - The insertion uses a replacer FUNCTION: a replacement STRING would
 *     expand `$&`, `` $` `` and `$'` patterns inside the spliced script.
 */

import { INJECT_SCRIPT } from "../components/edit/inject-script.js";

const BODY_CLOSE_RE = /<\/body\s*>/i;

/** What the overlay runtime reads from `window.__caelo` on every load. */
export interface OverlayPageContext {
  pageId: string;
  slug: string;
  path: string;
}

/**
 * A `window.__caelo = …;` statement that is safe inside an inline script.
 * U+2028 / U+2029 are escaped too: valid in JSON, a line break in older JS.
 */
export function overlayContextScript(ctx: OverlayPageContext): string {
  const json = JSON.stringify(ctx)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.__caelo=${json};`;
}

/**
 * Insert the overlay runtime before `</body>` (appended when the page has
 * none).
 *
 * @param html - the composed preview page.
 * @param ctx - the page the iframe shows; omitted when the parent already
 *   knows it (the by-id preview).
 */
export function injectEditOverlay(html: string, ctx?: OverlayPageContext): string {
  const scriptTag = `<script data-caelo-edit-overlay>${ctx ? overlayContextScript(ctx) : ""}${INJECT_SCRIPT}</script>`;
  return BODY_CLOSE_RE.test(html)
    ? html.replace(BODY_CLOSE_RE, () => `${scriptTag}</body>`)
    : html + scriptTag;
}
