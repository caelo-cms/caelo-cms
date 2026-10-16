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
 *   - `_assets/fonts/pinned/<sha256>.<12 hex>.<slice>.<12 hex>.woff2` —
 *     WOFF2 unicode-range slices derived from a registry font: the sha256
 *     of the pinned source, the hash of the effective axis spec (#793)
 *     and the delivery-toolchain tag (`font-service/src/delivery.ts`),
 *     which together determine the bytes. The file-name shape is
 *     {@link PINNED_FONT_SLICE_FILE_PATTERN}. (The sibling
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

/**
 * Regex (source string, unanchored) for the file name of a pinned-font
 * slice: `<source sha256>.<axis-spec hash 12>.<slice>.<toolchain tag 12>.woff2`
 * (`apps/static-generator/src/pinned-font-delivery.ts` builds it). The
 * ONE definition every consumer derives from — the cache policy below
 * and the admin's preview font route. #793 added the axis-spec hash to
 * the name; the route and this policy each kept their own copy of the
 * old shape, so the editor preview 404'd every pinned font and the
 * published slices lost their immutable cache lifetime. RE2-compatible.
 */
export const PINNED_FONT_SLICE_FILE_PATTERN =
  "[0-9a-f]{64}\\.[0-9a-f]{12}\\.[a-z]+(?:-[a-z]+)?\\.[0-9a-f]{12}\\.woff2";

const PINNED_FONT_SLICE_FILE_RE = new RegExp(`^${PINNED_FONT_SLICE_FILE_PATTERN}$`);

/** True when `fileName` (no directory) is a pinned-font slice name. */
export function isPinnedFontSliceFile(fileName: string): boolean {
  return PINNED_FONT_SLICE_FILE_RE.test(fileName);
}

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
export const CONTENT_HASHED_PATH_PATTERN = `^/(?:_app/immutable/.+|_assets/fonts/[^/]+/[0-9a-f]{16}\\.woff2|_assets/fonts/pinned/${PINNED_FONT_SLICE_FILE_PATTERN}|_assets/[a-z0-9][a-z0-9-]*(?:/[a-z][a-z0-9-]*)?\\.[0-9a-f]{16}\\.[a-z0-9]{2,5}|_caelo/plugin/[^/]+/[^/]+\\.[0-9a-f]{12}\\.(?:js|css))$`;

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
