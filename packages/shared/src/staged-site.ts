// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1330 — the staged site as staging storage holds it, shared by the
 * admin (which writes it at every Stage) and the staging gateway (which
 * serves it behind the gate).
 *
 * Staging storage always holds complete builds (decision 2026-11-04, D1):
 * on the cloud providers two slots of the private staging bucket
 * (`_slots/a`, `_slots/b`), on a self-hosted install the run's build
 * directory. A Stage syncs the slot staging does not serve (only changed
 * files are written, removed ones deleted) and then points the projection
 * at it, so a half-synced build is never served. Every build location has a
 * manifest next to it, {@link stagedManifestKey}: the files it serves, each
 * with its Content-Type and a content hash (the next Stage's diff), plus the
 * run, the page URL style and the origin the pages were rendered for.
 *
 * The gateway serves only paths the manifest lists, so a request can never
 * name a storage key outside the location (prefix-bound by construction),
 * and every manifest key is a plain path ({@link isSafeStagedPath}).
 *
 * Content-Type and Cache-Control follow the same rules the live publishers
 * use (moved here from admin-core `static-file-policy.ts`, which re-exports
 * them), so staging answers like production does.
 */

import { z } from "zod";
import {
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  isContentHashedPath,
} from "./static-cache-policy.js";
import { STATIC_FILE_CONTENT_TYPES } from "./static-files.js";

/** The two cloud slots a Stage alternates between. */
export const STAGING_SLOTS = ["a", "b"] as const;
export type StagingSlot = (typeof STAGING_SLOTS)[number];

/** Storage location of a cloud slot (`_slots/a`). */
export function stagingSlotLocation(slot: StagingSlot): string {
  return `_slots/${slot}`;
}

/** The slot a Stage fills next: the one `servedLocation` does not name. */
export function nextStagingSlot(servedLocation: string | null): StagingSlot {
  return servedLocation === stagingSlotLocation("a") ? "b" : "a";
}

/**
 * A build location as the projection publishes it (`_slots/a`,
 * `builds/<runId>`): relative, plain segments, no traversal.
 */
export const STAGED_LOCATION_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/;

/** True when `location` is a location {@link STAGED_LOCATION_PATTERN} admits and no segment is `.`/`..`. */
export function isSafeStagedLocation(location: string): boolean {
  return (
    location.length <= 200 &&
    STAGED_LOCATION_PATTERN.test(location) &&
    location.split("/").every((s) => s !== "." && s !== "..")
  );
}

/** Storage key of the manifest of the build at `location`. */
export function stagedManifestKey(location: string): string {
  return `${location}.manifest.json`;
}

/** Storage key of `path` (a manifest path) of the build at `location`. */
export function stagedFileKey(location: string, path: string): string {
  return `${location}/${path}`;
}

/**
 * A build-relative path a staged build may serve: plain `/`-separated
 * segments, no `.`/`..`, no backslash, NUL or control character, no leading
 * slash.
 */
export function isSafeStagedPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((s) => s.length > 0 && s !== "." && s !== "..");
}

const stagedFileSchema = z.object({
  /** Content-Type the file is served with. */
  type: z.string().min(1).max(200),
  /** Content hash; only compared for equality by the next Stage's diff. */
  hash: z.string().min(1).max(200),
});

/** The manifest of one staged build ({@link stagedManifestKey}). */
export const stagedManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  pageUrlStyle: z.enum(["directory", "no-extension"]),
  files: z
    .record(z.string(), stagedFileSchema)
    .refine((files) => Object.keys(files).every(isSafeStagedPath), {
      message: "every path must be a plain build-relative path",
    }),
  /**
   * #1454 — the headers of the build's pages (`SiteHeaderSet.headers`).
   * Absent on a build staged before they existed.
   */
  securityHeaders: z.record(z.string(), z.string()).optional(),
});

export type StagedManifest = z.infer<typeof stagedManifestSchema>;
export type StagedFileEntry = z.infer<typeof stagedFileSchema>;

/**
 * Map a request path to the manifest paths to try, or null when the path is
 * not a plain, safe site path. Pure.
 *
 * `/` → `index.html`; `/about/` → `about/index.html`; `/about` → `about`
 * (no-extension builds) then `about/index.html`.
 */
export function stagedKeysFor(requestPath: string): string[] | null {
  const pathOnly = requestPath.split("?")[0]?.split("#")[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return null;
  const key = segments.join("/");
  if (key === "") return ["index.html"];
  if (decoded.endsWith("/")) return [`${key}/index.html`];
  return [key, `${key}/index.html`];
}

/** True for an HTML document's Content-Type (#1454: the page headers go on these). */
export function isHtmlContentType(contentType: string): boolean {
  return contentType.trimStart().toLowerCase().startsWith("text/html");
}

function extensionOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Content-Type by file extension (`application/octet-stream` when unknown). */
export function contentTypeFor(key: string): string {
  switch (extensionOf(key)) {
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
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
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
  // #1461 — a static file keeps its URL when its text changes, so it must
  // not linger like an asset. `_…` paths are the build's own.
  if (
    !key.startsWith("_") &&
    (STATIC_FILE_CONTENT_TYPES as readonly string[]).includes(
      contentType.split(";")[0]?.trim() ?? "",
    )
  ) {
    return "public, max-age=300";
  }
  return "public, max-age=3600";
}

/**
 * Whether a staged file of `contentType` carries absolute URLs the staging
 * gateway rewrites to the staging host: pages, sitemaps, feeds, styles,
 * scripts, JSON and plain text. Binary files pass through untouched.
 */
export function isRewritableContentType(contentType: string): boolean {
  const t = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    t.startsWith("text/") ||
    t === "application/xml" ||
    t === "application/javascript" ||
    t === "application/json" ||
    t === "application/manifest+json" ||
    t === "application/rss+xml" ||
    t === "application/atom+xml" ||
    t === "image/svg+xml"
  );
}

/**
 * The byte-level replacements that point a build rendered for `fromOrigin`
 * (the live site, `https://example.com`) at `toOrigin` (the staging host):
 * the origin as written, and as JSON escapes it inside inline data.
 */
export function originRewritePairs(
  fromOrigin: string,
  toOrigin: string,
): readonly (readonly [string, string])[] {
  const jsonEscaped = (o: string) => o.replaceAll("/", "\\/");
  return [
    [fromOrigin, toOrigin],
    [jsonEscaped(fromOrigin), jsonEscaped(toOrigin)],
  ];
}

/** Characters that may follow an origin in a URL or around one (never a host or port character). */
const AFTER_ORIGIN = String.raw`(?=[/"'?#\s<>),;\\\]}&|]|$)`;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A stream transform that replaces every occurrence of each `from` origin
 * with its `to`, also across chunk boundaries. An origin only matches as a
 * whole: `https://example.com` is not rewritten inside
 * `https://example.community` or `https://example.com:8443`. The transform
 * holds back the last bytes of each chunk until the next one (or the end)
 * shows whether they are, or start, a match. Works on UTF-8 text; the
 * origins are ASCII, so a match never splits a multi-byte character.
 *
 * @example
 *   body.pipeThrough(originRewriteStream(originRewritePairs("https://example.com", "https://staging.example.com")))
 */
export function originRewriteStream(
  pairs: readonly (readonly [string, string])[],
): TransformStream<Uint8Array, Uint8Array> {
  const usable = pairs.filter(([from]) => from.length > 0);
  const patterns = usable.map(
    ([from, to]) => [new RegExp(`${escapeRegExp(from)}${AFTER_ORIGIN}`, "g"), to] as const,
  );
  // A match plus the one character that decides whether it is whole.
  const keep = Math.max(0, ...usable.map(([from]) => from.length));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const replaceAll = (text: string): string => {
    let out = text;
    for (const [re, to] of patterns) out = out.replace(re, to);
    return out;
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let cut = pending.length - keep;
      if (cut <= 0) return;
      // An occurrence that reaches the cut (or ends right at it, its next
      // character unseen by the head) moves the cut to its start; it is
      // decided with the next chunk.
      for (const [from] of usable) {
        let at = pending.indexOf(from, Math.max(0, cut - from.length));
        while (at !== -1 && at < cut) {
          if (at + from.length >= cut) {
            cut = at;
            break;
          }
          at = pending.indexOf(from, at + 1);
        }
      }
      if (cut <= 0) return;
      const head = pending.slice(0, cut);
      pending = pending.slice(cut);
      controller.enqueue(encoder.encode(replaceAll(head)));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.length > 0) controller.enqueue(encoder.encode(replaceAll(pending)));
    },
  });
}
