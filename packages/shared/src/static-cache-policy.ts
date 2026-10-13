// SPDX-License-Identifier: MPL-2.0

/**
 * Cache-Control policy for the published static site — the single
 * source of truth every static publisher (GCS object metadata,
 * Firebase Hosting version headers, self-hosted Caddy) derives from.
 *
 * The rule: only a URL whose bytes can never change may be cached
 * forever. That holds exactly when the URL itself changes whenever the
 * content does, i.e. the file name carries a content hash. Everything
 * else (pages, robots.txt, sitemap.xml, manifests) must stay short-lived
 * or revalidating so a publish shows up promptly.
 *
 * Content-hashed paths the static generator emits today:
 *
 *   - `_assets/fonts/<family-slug>/<16 hex>.woff2` — self-hosted
 *     Google Fonts faces; the name is a hash of the upstream face URL,
 *     which Google versions per file (a changed face gets a new URL,
 *     hence a new name).
 *   - `_assets/fonts/pinned/<sha256>.<ttf|otf|woff|woff2>` — library
 *     fonts pinned by the sha256 of their bytes. (The sibling
 *     `pinned/<font-id>.license.txt` is id-named, NOT hashed.)
 *   - `_caelo/plugin/<slug>/<stem>.<12 hex>.<js|css>` — plugin client
 *     assets, sha256 of the content in the name
 *     (`plugin-host/src/client-assets.ts`).
 *   - `_app/immutable/**` — Vite's hashed-output convention, kept for
 *     builds that ship SvelteKit-style bundles.
 *   - `_assets/<slug>.<16 hex>.<ext>` and
 *     `_assets/<slug-or-id>/<variant>.<16 hex>.<ext>` — published media
 *     (#667), named by the sha256 of the published bytes
 *     (`apps/static-generator/src/media-asset-path.ts`). Before #667 media
 *     shipped under its bare slug, which the operator can re-point at new
 *     bytes, so it could only get a 1-hour lifetime and Lighthouse flagged
 *     every logo and image ("Use efficient cache lifetimes").
 *
 * NOT content-hashed (deliberately excluded): pages, robots.txt,
 * sitemap.xml, the manifests, the pinned-font `.license.txt` files (named
 * by font id) and media under the pre-#667 bare-slug names.
 */

/** Long-lived policy for content-addressed files. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Short, background-revalidated policy for pages (HTML documents). */
export const HTML_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=86400";

/**
 * Regex (source string) matching every content-hashed URL path. It is
 * matched against a site-absolute path ("/_assets/…") and uses only the
 * syntax shared by ECMAScript and RE2 (no lookaround, no backrefs), so
 * the same string can be handed to Firebase Hosting's `regex` header
 * matcher and Caddy's `path_regexp` (both RE2) and to `RegExp` here.
 */
export const CONTENT_HASHED_PATH_PATTERN =
  "^/(?:_app/immutable/.+|_assets/fonts/[^/]+/[0-9a-f]{16,64}\\.(?:woff2|woff|ttf|otf)|_assets/[a-z0-9][a-z0-9-]*(?:/[a-z][a-z0-9-]*)?\\.[0-9a-f]{16}\\.[a-z0-9]{2,5}|_caelo/plugin/[^/]+/[^/]+\\.[0-9a-f]{12}\\.(?:js|css))$";

/** Hex length of the content hash in published media names (#667). */
export const MEDIA_CONTENT_HASH_HEX_LENGTH = 16;

const CONTENT_HASHED_PATH_RE = new RegExp(CONTENT_HASHED_PATH_PATTERN);

/**
 * True when `path` names a content-addressed build output. Accepts a
 * build-dir-relative key (`_assets/fonts/inter/ab….woff2`, as the GCS
 * publisher sees it) or a site-absolute URL path (`/_assets/…`).
 */
export function isContentHashedPath(path: string): boolean {
  return CONTENT_HASHED_PATH_RE.test(path.startsWith("/") ? path : `/${path}`);
}
