// SPDX-License-Identifier: MPL-2.0

/**
 * Security response headers for uploaded media and the published static
 * site — the one definition the admin's media routes, the staging preview,
 * every static publisher and every provider stack's edge config derive
 * from (#863, #891).
 *
 * An SVG opened directly (`https://<site>/_assets/logo.<hash>.svg`) is a
 * document, not an image: it runs script in the origin it is served from.
 * On the public site that origin also serves `/api/*` (the gateway behind
 * the same load balancer, CLAUDE.md §11.B), on the admin it holds the
 * operator's session. `sanitizeSvg` strips script at upload; this CSP is
 * the line behind it should a construct ever get past the sanitizer: no
 * script, no plugins, no network, and `sandbox` gives the document an
 * opaque origin. Inline styles and `data:` rasters / fonts stay allowed so
 * an SVG renders exactly as before — as a document and as an `<img>`.
 * Browsers apply a CSP only to documents (and workers), so the header
 * changes nothing for an SVG loaded through `<img>` or CSS.
 *
 * Only SVG gets the CSP: raster images, video and fonts cannot run script,
 * and `sandbox` would stop Chrome's built-in viewer from opening a PDF.
 * `nosniff` goes on everything so a browser never reinterprets bytes as a
 * scriptable type the content-type did not declare.
 */

/** The CSP an SVG document is served with (see the file comment). */
export const SVG_DOCUMENT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";

/** `X-Content-Type-Options` value every media / static response carries. */
export const NOSNIFF = "nosniff";

/** The MIME type the CSP is keyed on. */
export const SVG_CONTENT_TYPE = "image/svg+xml";

/**
 * Regex (source string, unanchored at the start) matching a URL path that
 * ends in `.svg`, any case. Only syntax shared by ECMAScript and RE2 (no
 * inline flags), so the same string serves Firebase Hosting's `regex`
 * header matcher and `RegExp` here. The static generator names every file
 * by extension (`contentTypeFor` in admin-core), so the extension is what
 * decides the served `image/svg+xml`.
 */
export const SVG_PATH_PATTERN = "\\.[sS][vV][gG]$";

/** True when `contentType` is SVG (case and parameters such as `; charset=` ignored). */
export function isSvgContentType(contentType: string): boolean {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase() === SVG_CONTENT_TYPE;
}

/**
 * Security headers for one media / static-file response.
 *
 * @param contentType - the `content-type` the response is served with.
 * @returns lower-case header entries to spread into the response's headers.
 * @example
 *   new Response(body, { headers: { "Content-Type": ct, ...mediaSecurityHeaders(ct) } });
 */
export function mediaSecurityHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "x-content-type-options": NOSNIFF };
  if (isSvgContentType(contentType)) headers["content-security-policy"] = SVG_DOCUMENT_CSP;
  return headers;
}
