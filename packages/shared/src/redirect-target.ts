// SPDX-License-Identifier: MPL-2.0

/**
 * The one validator for a redirect's TARGET (`toPath`) — issue #657.
 *
 * Caelo redirects only ever point at a path on the same site: the
 * `redirects` table has no external-URL field, and every surface that
 * serves the table (the admin's 404 fallback, the generator's
 * `_redirects` / `_redirects.caddy`, the per-provider emitters) writes
 * `toPath` verbatim into a `Location` header. "Starts with `/`" is not
 * enough for that to stay on-site:
 *
 *   - `//host/x` (and `/\host/x`, which browsers normalise to `//`) is a
 *     protocol-relative URL — the browser leaves the site for `host`.
 *     That turns any redirect into an open redirect.
 *   - `/https://example.com/x` is a same-site path whose first segment is
 *     `https:`; the browser lands on `https://<site>/https://example.com/x`,
 *     which is never what the author meant (they pasted a full URL).
 *   - Whitespace / control characters: browsers strip tab/CR/LF inside a
 *     URL, so `/\t/host` collapses to `//host`; the `_redirects` formats
 *     are whitespace-delimited and the emitters already refuse them.
 *
 * Every write path (redirects.create / create_many, page delete with
 * `disposition: 'redirect'`, the AI tool schemas, the import composer)
 * and every serving path (static generator, admin 404 fallback) calls
 * this, so a value rejected at write time can never be served either.
 */

import { z } from "zod";

/** Max length of a stored redirect path (matches the op schemas). */
const REDIRECT_PATH_MAX_LENGTH = 500;

/** A URL scheme token (RFC 3986 §3.1) followed by `:`. */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** Schemes that are never a meaningful first path segment. A pasted
 *  `/https:/x` (slashes collapsed by a form or a CSV tool) is the same
 *  mistake as `/https://x`, so these are rejected even without `//`. */
const WEB_SCHEMES = new Set(["http", "https"]);

const EXTERNAL_NOT_SUPPORTED =
  "Redirects can only target a path on this site (e.g. '/pricing'); external (other-domain) redirect targets are not supported. If the destination is a page on this site, pass only its path.";

/**
 * Return why `toPath` is not a safe same-site redirect target, or `null`
 * when it is. The message is written for the AI: it names the problem
 * and what to pass instead.
 *
 * @example
 *   redirectTargetIssue("/blog/new?x=1#top")    // null
 *   redirectTargetIssue("//evil.example/x")     // "... protocol-relative ..."
 *   redirectTargetIssue("/https://a.example/x") // "... use '/x' ..."
 */
export function redirectTargetIssue(toPath: string): string | null {
  const shown = JSON.stringify(toPath);
  if (!toPath.startsWith("/")) {
    return `toPath ${shown} must start with '/'. ${EXTERNAL_NOT_SUPPORTED}`;
  }
  if (/[\s\p{Cc}]/u.test(toPath)) {
    return `toPath ${shown} contains whitespace or control characters. Percent-encode them (a space is '%20') or remove them.`;
  }
  if (toPath.includes("\\")) {
    return `toPath ${shown} contains a backslash; browsers treat '\\' as '/', so it can turn into a link to another host. Use forward slashes only.`;
  }
  if (toPath.startsWith("//")) {
    return `toPath ${shown} starts with '//', which browsers read as a protocol-relative URL to another host (an open redirect), not as a path on this site. Use a single leading slash, e.g. '/${trimLeadingSlashes(toPath)}'. ${EXTERNAL_NOT_SUPPORTED}`;
  }
  const scheme = SCHEME_PREFIX.exec(toPath.slice(1));
  if (scheme) {
    const rest = toPath.slice(1 + scheme[0].length);
    const name = (scheme[1] ?? "").toLowerCase();
    if (rest.startsWith("/") || WEB_SCHEMES.has(name)) {
      const suggestion = pathOfEmbeddedUrl(toPath.slice(1));
      const hint = suggestion ? ` If that URL is on this site, use its path '${suggestion}'.` : "";
      return `toPath ${shown} embeds a full URL ('${scheme[1]}:…') after the leading '/'; browsers resolve it as a path on this site, not as that URL.${hint} ${EXTERNAL_NOT_SUPPORTED}`;
    }
  }
  return null;
}

/**
 * Zod schema for a redirect target. Use this — not a bare
 * `z.string().regex(/^\//)` — wherever a redirect target enters the
 * system, so the rule above holds on every path.
 */
export const redirectTargetPathSchema = z
  .string()
  .min(1)
  .max(REDIRECT_PATH_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const issue = redirectTargetIssue(value);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
  });

function trimLeadingSlashes(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 47 /* '/' */) i += 1;
  return s.slice(i);
}

/** `https://a.example/x?y#z` → `/x?y#z`; null when unparseable. */
function pathOfEmbeddedUrl(url: string): string | null {
  // Only a well-formed `scheme://host` URL has a path worth suggesting;
  // `https:/x` would parse as host `x` and suggest a misleading '/'.
  if (!/^https?:\/\/[^/]/i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}
