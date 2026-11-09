// SPDX-License-Identifier: MPL-2.0

/**
 * The response headers Caelo puts in every Firebase Hosting version, and the
 * refresh every copy of a version passes through.
 *
 * SCHEMA CONTRACT (getting this wrong is a 400 at deploy): the REST API at
 * `sites.versions.create` takes each entry's `headers` as a
 * map<string, string>. The Firebase CLI's firebase.json uses an array of
 * `{key, value}` and translates it; the REST API does not. Mixing the two
 * was the v0.3.1 → v0.6.2 staging-deploy bug ("Cannot bind a list to map
 * for field 'headers'").
 * Spec: https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.versions#Header
 *
 * MATCHING CONTRACT — a `regex` must match the WHOLE request path. The
 * reference says only "The user-supplied RE2 regular expression to match
 * against the request URL path" (`Header.regex`, same for redirects and
 * rewrites). The guide's examples are what pin the semantics
 * (https://firebase.google.com/docs/hosting/full-config): the redirect
 * regex `/firebase/.*` is "equivalent to" the glob `/firebase/**`, the
 * rewrite regex `/foo(/.*)?` to the glob `/foo{,/**}`, and the header regex
 * `.+/\w+\.(jpg|jpeg|gif|png)$` starts with `.+` — all only true when the
 * pattern has to cover the whole path (RE2 FullMatch). The API confirms it
 * by what it stores: a version created with `^/` comes back from
 * `GET sites/<s>/channels/live` as `^/$`, with `\.ico$` as `^\.ico$`. Until
 * this was found on a live install (v0.12.1) nosniff reached only `/`, and
 * no SVG got its sandboxing CSP: a regex searched like `RegExp.test` here
 * is not the regex Hosting runs. So every pattern below starts with `^/`
 * and ends with `$` — anchored, a search and a whole-path match agree, and
 * the API stores the string unchanged. The header tests evaluate entries
 * as whole-path matches (static-publisher-firebase-headers.test.ts).
 *
 * A pattern is matched against the REQUEST path, not the file served: a
 * page requested as `/about/` is served from `/about/index.html` but never
 * matches `*.html`.
 *
 * No two entries set the same header on one path: Hosting applies every
 * matching entry and does not document which one wins. The two
 * Cache-Control entries are disjoint, the Content-Type entries (favicon,
 * static files) are disjoint, the SVG CSP is disjoint from the page-header
 * entry (`SITE_DOCUMENT_PATH_PATTERN`), and nosniff is set by no other
 * entry.
 */

import {
  CONTENT_HASHED_PATH_PATTERN,
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  NOSNIFF,
  SITE_DOCUMENT_PATH_PATTERN,
  SVG_DOCUMENT_CSP,
  SVG_PATH_PATTERN,
} from "@caelo-cms/shared";

/** One entry of a Hosting version's `config.headers` (REST shape). */
export interface FirebaseHeaderEntry {
  glob?: string;
  regex?: string;
  headers: Record<string, string>;
}

/** The slice of a Hosting version `config` the header code inspects;
 *  every other field (rewrites, redirects, …) passes through untouched. */
export interface FirebaseVersionConfig {
  headers?: ReadonlyArray<FirebaseHeaderEntry>;
  [field: string]: unknown;
}

/**
 * RE2 pattern for "every path whose first segment neither starts with
 * `_` nor is exactly `api`" — RE2 has no lookahead, so the `api`
 * exclusion is spelled out character by character. Matches `/`,
 * `/about/`, `/about`, `/apiary`, `/robots.txt`; rejects `/_assets/…`,
 * `/api`, `/api/…`.
 */
export const FIREBASE_SHORT_CACHE_PATH_PATTERN =
  "^/(?:(?:[^_a/][^/]*|a(?:[^p/][^/]*)?|ap(?:[^i/][^/]*)?|api[^/]+)(?:/.*)?)?$";

/** Every request path. */
export const FIREBASE_EVERY_PATH_PATTERN = "^/.*$";

/** A request path ending in `.ico` (theme favicons). */
export const FIREBASE_ICO_PATH_PATTERN = "^/.*\\.ico$";

/**
 * `Content-Type: image/x-icon` on `.ico` files: the one icon MIME the media
 * library stores and `<link rel="icon" type>` declares, instead of whatever
 * Hosting's extension table picks. Static files (#1461) never end in
 * `.ico`, so no static-file entry sets Content-Type on the same path.
 */
export const FAVICON_CONTENT_TYPE_ENTRY = {
  regex: FIREBASE_ICO_PATH_PATTERN,
  headers: { "Content-Type": "image/x-icon" },
} as const;

/**
 * #891 — every response `nosniff`, every SVG the sandboxing CSP. Neither
 * sets Cache-Control or Content-Type, so they overlap the cache and type
 * entries without two entries ever setting the same header.
 */
export const SECURITY_HEADER_ENTRIES = [
  {
    regex: FIREBASE_EVERY_PATH_PATTERN,
    headers: { "X-Content-Type-Options": NOSNIFF },
  },
  {
    regex: SVG_PATH_PATTERN,
    headers: { "Content-Security-Policy": SVG_DOCUMENT_CSP },
  },
] as const;

/**
 * The headers of every version a build creates (a build adds its
 * static-file types, its page headers and the env's robots entry).
 *
 *   1. Content-hashed build outputs (fonts, plugin bundles, media since
 *      #667, `CONTENT_HASHED_PATH_PATTERN`) → immutable, 1 year. All live
 *      under a `/_…` top-level directory.
 *   2. Every path whose first segment does not start with `_` and is not
 *      `api` → short + stale-while-revalidate: pages (`/`, `/about/`,
 *      `/about.html`, `/about`), robots.txt, sitemap.xml, root manifests. A
 *      publish creates a new release (Hosting purges its CDN), visitors get
 *      it within 60s.
 *
 * Paths matching neither keep Hosting's default (`max-age=3600`): pre-#667
 * media under a bare slug (stable URL, replaceable bytes, must not be
 * immutable), the pinned-font license files and the `/api/**` rewrite to
 * the gateway (its own headers stay authoritative). Then the favicon type
 * and the security entries.
 */
export const VERSION_CONFIG_HEADERS = [
  {
    regex: CONTENT_HASHED_PATH_PATTERN,
    headers: { "Cache-Control": IMMUTABLE_CACHE_CONTROL },
  },
  {
    regex: FIREBASE_SHORT_CACHE_PATH_PATTERN,
    headers: { "Cache-Control": HTML_CACHE_CONTROL },
  },
  FAVICON_CONTENT_TYPE_ENTRY,
  ...SECURITY_HEADER_ENTRIES,
] as const;

/**
 * The entries a copy of a version replaces with the current ones. They
 * belong to the release, not to the build: a version staged or released
 * before a fix to them must not take the old ones live again.
 */
const FIXED_ENTRIES: readonly FirebaseHeaderEntry[] = [
  FAVICON_CONTENT_TYPE_ENTRY,
  ...SECURITY_HEADER_ENTRIES,
];

const SECURITY_HEADER_NAMES = new Set(
  SECURITY_HEADER_ENTRIES.flatMap((e) => Object.keys(e.headers).map((k) => k.toLowerCase())),
);

/** True for an entry of {@link FIXED_ENTRIES}' kind, in whatever form an older release wrote it. */
function isFixedEntry(entry: FirebaseHeaderEntry): boolean {
  // The page headers (#1454) carry a CSP too, but they belong to the build.
  if (entry.regex === SITE_DOCUMENT_PATH_PATTERN) return false;
  return Object.entries(entry.headers ?? {}).some(
    ([name, value]) =>
      SECURITY_HEADER_NAMES.has(name.toLowerCase()) ||
      (name.toLowerCase() === "content-type" &&
        value === FAVICON_CONTENT_TYPE_ENTRY.headers["Content-Type"]),
  );
}

/**
 * Return `config` with the current fixed entries (favicon type, nosniff,
 * SVG CSP) in place of whatever such entries it carried; everything else
 * (cache entries, static-file types, page headers, robots) is kept.
 * Promote, rollback, the plugin-data release and the redirect sync all copy
 * an existing version's config, and this is what keeps a version from
 * before #891 — or one with the unanchored patterns Hosting matched only
 * on `/` — from going live (again) without its security headers.
 */
export function withCurrentFixedHeaders(config: FirebaseVersionConfig): FirebaseVersionConfig {
  const kept = (config.headers ?? []).filter((e) => !isFixedEntry(e));
  return { ...config, headers: [...kept, ...FIXED_ENTRIES] };
}

/**
 * A regex the way Hosting stores it: anchored at both ends (see the file
 * comment). Lets a config read back from the API compare equal to the one
 * written.
 */
function storedRegex(regex: string): string {
  const head = regex.startsWith("^") ? regex : `^${regex}`;
  return head.endsWith("$") ? head : `${head}$`;
}

function canonicalEntry(e: FirebaseHeaderEntry): string {
  const headers = Object.entries(e.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    e.glob ?? null,
    e.regex === undefined ? null : storedRegex(e.regex),
    headers,
  ]);
}

/**
 * True when `config` (as written, or as the REST API returns it) already
 * carries exactly the current fixed entries — the redirect sync and the
 * admin's boot check then have no header reason to release.
 */
export function hasCurrentFixedHeaders(config: FirebaseVersionConfig): boolean {
  const fixed = (config.headers ?? []).filter(isFixedEntry).map(canonicalEntry).sort();
  const current = FIXED_ENTRIES.map(canonicalEntry).sort();
  return fixed.length === current.length && fixed.every((v, i) => v === current[i]);
}
