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
 * each rule matches both spellings.
 *
 * Precedence: Hosting consults `config.redirects` BEFORE exact-match
 * static content, the reverse of every other Caelo surface (the admin's
 * 404 fallback, `redirects.lookup`), where a live page always wins over
 * a recorded redirect. A row whose `from` is a live page again (slug
 * ping-pong, a URL migration undone — `/x` → `/de/x` stays recorded
 * after `/de/x` → `/x` moved the page back) would otherwise shadow that
 * page, or loop with the reverse row. Rules whose `from` path is served
 * by a file in this build are therefore left out.
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

/** Does a file of the build answer `bare` (no trailing slash)? Hosting
 *  serves `/x` from the file `x` and from the directory index
 *  `x/index.html`. */
function servedByBuild(bare: string, servedFiles: ReadonlySet<string>): boolean {
  if (bare === "/") return servedFiles.has("index.html");
  const rel = bare.slice(1);
  return servedFiles.has(rel) || servedFiles.has(`${rel}/index.html`);
}

/**
 * Translate the generator's `_redirects` file into Hosting redirect
 * rules. Throws on a malformed line — a rule silently dropped is a 404
 * on a URL someone links to.
 *
 * 410 rows are left out: Hosting can only answer a redirect rule with a
 * 3xx, and a gone page with no file already answers 404, the closest
 * status Hosting can give. Rows whose `from` path a build file serves
 * are left out too — the live page wins (see the module comment).
 *
 * @param redirectsFile Contents of `<buildDir>/_redirects`.
 * @param pageUrlStyle  The deploy target's page emission style.
 * @param servedFiles   Every file of the build, relative to the build
 *                      root without a leading slash (`de/preise/index.html`).
 */
export function firebaseRedirectsFromFile(
  redirectsFile: string,
  pageUrlStyle: "directory" | "no-extension",
  servedFiles: ReadonlySet<string>,
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
    if (servedByBuild(bare, servedFiles)) continue;
    const regex = bare === "/" ? "^/$" : `^${escapeRe2(bare)}/?$`;
    out.push({
      regex,
      location: locationFor(to, pageUrlStyle),
      statusCode: statusCode as FirebaseRedirect["statusCode"],
    });
  }
  return out;
}
