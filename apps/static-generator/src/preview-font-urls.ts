// SPDX-License-Identifier: MPL-2.0

/**
 * Font URLs a module wrote with the editor preview's path.
 *
 * The preview serves the theme's self-hosted fonts from the admin at
 * `/_caelo/fonts/<family>/<file>.woff2`; the build copies the same files
 * to `_assets/fonts/<family>/<file>.woff2`, and the theme's own
 * @font-face CSS and preloads already use that path. A module's CSS can
 * still carry the preview path: the AI reads the composed preview
 * (inspect_page_render) and copies an @font-face rule out of it, for
 * example to change `font-display`. Shipped as is, the live site asks
 * its static host for `/_caelo/fonts/...`, which only the admin serves,
 * and the font 404s (e2e-livedit run 38867358894, PR #795).
 *
 * The pass points every such URL at the file the build ships. A URL whose
 * file the build does not ship fails the build and names page and URL
 * (CLAUDE.md §2: no silent broken reference).
 */

/** `/_caelo/fonts/<family>/<file>` as the admin's font route serves it. */
const PREVIEW_FONT_URL = /\/_caelo\/fonts\/([a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)/g;

/**
 * Rewrite preview font URLs in every page's HTML in place.
 *
 * @param pages The composed pages; `html` is replaced.
 * @param shippedRelPaths `relPath`s of the font files copied into
 *   `_assets/fonts/` for this build.
 * @throws Error naming each page and URL whose file the build does not ship.
 */
export function rewritePreviewFontUrls(
  pages: { html: string; relPath: string }[],
  shippedRelPaths: ReadonlySet<string>,
): void {
  const missing: string[] = [];
  for (const page of pages) {
    page.html = page.html.replace(PREVIEW_FONT_URL, (url, relPath: string) => {
      if (shippedRelPaths.has(relPath)) return `/_assets/fonts/${relPath}`;
      missing.push(`${page.relPath}: ${url}`);
      return url;
    });
  }
  if (missing.length > 0) {
    throw new Error(
      `static-generator: ${missing.length} font URL(s) point at fonts this build does not ship — ${missing.join("; ")}. ` +
        "A module's CSS references a font file of the editor preview that the active theme no longer delivers. " +
        "Use the theme's font variables (var(--font-body), var(--font-heading), var(--font-mono)) in the module instead of a font URL, " +
        "or set the font in the theme's typography tokens (set_theme_tokens), then Stage again.",
    );
  }
}
