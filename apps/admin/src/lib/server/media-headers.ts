// SPDX-License-Identifier: MPL-2.0

/**
 * Response headers for user-uploaded media served from the ADMIN origin
 * (`/_caelo/media/*`, the staging preview proxy's `_assets/` files).
 *
 * An SVG opened directly is a document that runs in the admin origin, next
 * to the operator's session cookie. `sanitizeSvg` strips script at upload;
 * this CSP is the second line should a construct ever get past it: no
 * script, no plugins, no network, and `sandbox` gives the document an
 * opaque origin. Inline styles and `data:` rasters / fonts stay allowed so
 * an SVG renders exactly as before — both as a document and as an `<img>`.
 *
 * Only SVG gets the CSP: raster images, video and fonts cannot run script,
 * and `sandbox` would stop Chrome's built-in viewer from opening a PDF.
 * `nosniff` goes on everything so a browser never reinterprets bytes as a
 * scriptable type the content-type did not declare.
 */

/** The CSP an SVG document is served with (see the file comment). */
export const SVG_DOCUMENT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";

/**
 * Security headers for one media response.
 *
 * @param contentType - the `content-type` the response is served with
 *   (parameters such as `; charset=` are ignored).
 * @returns header entries to spread into the response's headers.
 */
export function mediaSecurityHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "x-content-type-options": "nosniff" };
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mime === "image/svg+xml") headers["content-security-policy"] = SVG_DOCUMENT_CSP;
  return headers;
}
