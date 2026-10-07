// SPDX-License-Identifier: MPL-2.0

/**
 * The redirects table on Firebase Hosting.
 *
 * Firebase serves no `_redirects` file: redirect rules live in the
 * Hosting version's `config.redirects`. The generator already writes the
 * whole table as `_redirects` (`<from> <to> <status>` per line) for
 * exactly this purpose — per-provider adapters translate it into what
 * their CDN consumes. Without this translation every 301 Caelo records
 * (slug changes, URL migrations, the `international-site` locale-root
 * redirect) would 404 on gcp-firebase installs.
 *
 * Matching: Caelo stores paths without a trailing slash, but in the
 * directory page style the same URL is also requested as `/old/`, so
 * each rule matches both spellings. Hosting serves an existing file
 * before it consults redirects, so a redirect from a path that is a
 * live page again never shadows the page.
 *
 * Location: in the directory style a page's URL is `/<path>/` (the
 * canonical form, see `resolveCanonicalUrl`), and Hosting itself 301s
 * `/<path>` to `/<path>/`. Pointing the rule at the slash form saves
 * visitors and crawlers that second hop.
 */

/** One entry of a Hosting version's `config.redirects` (REST shape). */
export interface FirebaseRedirect {
  readonly regex: string;
  readonly location: string;
  readonly statusCode: 301 | 302 | 307 | 308;
}

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/** Escape a literal for an RE2 pattern. */
function escapeRe2(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** In the directory style, internal page paths end in "/"; files
 *  (anything with an extension in its last segment) stay as they are. */
function locationFor(toPath: string, pageUrlStyle: "directory" | "no-extension"): string {
  if (pageUrlStyle !== "directory" || toPath.endsWith("/")) return toPath;
  if (!toPath.startsWith("/") || /[?#]/.test(toPath)) return toPath;
  const lastSegment = toPath.slice(toPath.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return toPath;
  return `${toPath}/`;
}

/**
 * Translate the generator's `_redirects` file into Hosting redirect
 * rules. Throws on a malformed line — a rule silently dropped is a 404
 * on a URL someone links to.
 *
 * 410 rows are left out: Hosting can only answer a redirect rule with a
 * 3xx, and a gone page with no file already answers 404, the closest
 * status Hosting can give.
 *
 * @param redirectsFile Contents of `<buildDir>/_redirects`.
 * @param pageUrlStyle  The deploy target's page emission style.
 */
export function firebaseRedirectsFromFile(
  redirectsFile: string,
  pageUrlStyle: "directory" | "no-extension",
): FirebaseRedirect[] {
  const out: FirebaseRedirect[] = [];
  const lines = redirectsFile.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(" ");
    const [from, to, status] = parts;
    const statusCode = Number(status);
    if (parts.length !== 3 || !from?.startsWith("/") || !to || !Number.isInteger(statusCode)) {
      throw new Error(
        `firebase-redirects: _redirects line ${index + 1} is not "<from> <to> <status>": ${JSON.stringify(raw)}. The static generator writes this file from the redirects table — fix the row there.`,
      );
    }
    if (statusCode === 410) continue;
    if (!REDIRECT_STATUSES.has(statusCode)) {
      throw new Error(
        `firebase-redirects: _redirects line ${index + 1} has status ${statusCode}; Firebase Hosting redirects must be 301, 302, 307 or 308.`,
      );
    }
    const bare = from.length > 1 && from.endsWith("/") ? from.slice(0, -1) : from;
    const regex = bare === "/" ? "^/$" : `^${escapeRe2(bare)}/?$`;
    out.push({
      regex,
      location: locationFor(to, pageUrlStyle),
      statusCode: statusCode as FirebaseRedirect["statusCode"],
    });
  }
  return out;
}
