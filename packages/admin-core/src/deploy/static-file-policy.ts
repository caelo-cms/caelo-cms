// SPDX-License-Identifier: MPL-2.0

/**
 * Content-Type, Cache-Control and (GCS) object metadata of a published
 * static file, keyed on its site path. Shared by the GCS publisher (object
 * metadata) and the #553
 * quality audit's loopback origin, which must serve a staged build exactly
 * the way staging would — Lighthouse audits caching (uses-long-cache-ttl,
 * #555) and content types (.ico favicons, #571).
 */

import { cacheControlForContentType, isSvgContentType } from "@caelo-cms/shared";

// #1330 — the rules live in @caelo-cms/shared staged-site.ts now, so the
// staging gateway serves a staged build with the same Content-Type and
// Cache-Control as the live publishers.
export { cacheControlForContentType, contentTypeFor } from "@caelo-cms/shared";

/**
 * Object metadata for a published file in a GCS bucket served through the
 * `gcp` stack's Cloud CDN backend bucket (#891).
 *
 * The public site must never render an uploaded SVG as a document on its
 * own origin (see `@caelo-cms/shared` static-security-headers.ts). Every
 * other provider attaches the SVG CSP at the edge; GCP cannot: GCS serves
 * only a fixed set of metadata headers (no CSP), a backend bucket's custom
 * response headers apply to every file it serves (pages too), and the URL
 * map's site path matcher holds the admin-managed redirect `pathRules`,
 * which cannot coexist with the `routeRules` a per-extension header action
 * would need. So on GCS an SVG is served `Content-Disposition: attachment`:
 * `<img>`, CSS and `<use>` load it as before, while opening its URL
 * downloads the file instead of running it on the site's origin. The
 * edge's `nosniff` comes from the backend bucket (stack-contract.ts).
 *
 * @param contentType - the Content-Type the object is stored with.
 * @param key - the site path (build-dir relative), which drives Cache-Control.
 */
export function gcsObjectMetadata(
  contentType: string,
  key: string,
): { cacheControl: string; contentDisposition?: string } {
  const cacheControl = cacheControlForContentType(contentType, key);
  return isSvgContentType(contentType)
    ? { cacheControl, contentDisposition: "attachment" }
    : { cacheControl };
}
