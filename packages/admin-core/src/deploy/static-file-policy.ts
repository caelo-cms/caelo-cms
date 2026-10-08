// SPDX-License-Identifier: MPL-2.0

/**
 * Content-Type and Cache-Control of a published static file, keyed on its
 * site path. Shared by the GCS publisher (object metadata) and the #553
 * quality audit's loopback origin, which must serve a staged build exactly
 * the way staging would — Lighthouse audits caching (uses-long-cache-ttl,
 * #555) and content types (.ico favicons, #571).
 */

import { extname } from "node:path";
import {
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  isContentHashedPath,
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

/** Cache-Control for a file of `contentType` served at site path `key`. */
export function cacheControlForContentType(contentType: string, key: string): string {
  // Content-hashed outputs (fonts, plugin bundles, Vite chunks) are
  // immutable regardless of content-type — the hash in the path is the
  // signal. Slug-addressed media stays on the 1h default below.
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
