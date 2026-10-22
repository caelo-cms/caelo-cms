// SPDX-License-Identifier: MPL-2.0

/**
 * Content-Type, Cache-Control and (GCS) object metadata of a published
 * static file, keyed on its site path. Shared by the GCS publisher (object
 * metadata) and the #553
 * quality audit's loopback origin, which must serve a staged build exactly
 * the way staging would — Lighthouse audits caching (uses-long-cache-ttl,
 * #555) and content types (.ico favicons, #571).
 */

import { extname } from "node:path";
import {
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  isContentHashedPath,
  isSvgContentType,
} from "@caelo-cms/shared";

/** Content-Type by file extension (`application/octet-stream` when unknown). */
export function contentTypeFor(key: string): string {
  const ext = extname(key).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

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

/** Cache-Control for a file of `contentType` served at site path `key`. */
export function cacheControlForContentType(contentType: string, key: string): string {
  // Content-hashed outputs (fonts, plugin bundles, media, Vite chunks)
  // are immutable regardless of content-type — the hash in the path is
  // the signal. Anything else under `_assets/` stays on the 1h default.
  if (isContentHashedPath(key)) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  if (contentType.startsWith("text/html")) {
    return HTML_CACHE_CONTROL;
  }
  if (key === "routing-manifest.json" || key === "_content-types.json") {
    return "public, max-age=10";
  }
  if (contentType.startsWith("application/json")) {
    return "public, max-age=60";
  }
  if (key === "robots.txt" || key === "sitemap.xml") {
    return "public, max-age=300";
  }
  return "public, max-age=3600";
}
