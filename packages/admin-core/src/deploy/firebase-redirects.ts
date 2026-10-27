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

import {
  buildRedirectPlan,
  parseRedirectsFile,
  type RedirectPlan,
  type RedirectStatusCode,
} from "@caelo-cms/shared";

/** One entry of a Hosting version's `config.redirects` (REST shape). */
export interface FirebaseRedirect {
  readonly regex: string;
  readonly location: string;
  readonly statusCode: RedirectStatusCode;
}

/** Escape a literal for an RE2 pattern. */
function escapeRe2(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate the generator's `_redirects` file into Hosting redirect
 * rules, through the redirect plan every provider serves (#587:
 * `buildRedirectPlan` — exact paths, chain collapse, the build wins).
 * Throws on a malformed line or a row no host can serve — a rule
 * silently dropped is a 404 on a URL someone links to.
 *
 * 410 rows are left out: Hosting can only answer a redirect rule with a
 * 3xx, and a gone page with no file already answers 404, the closest
 * status Hosting can give.
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
  return firebaseRedirectsFromPlan(
    buildRedirectPlan({
      rows: parseRedirectsFile(redirectsFile),
      pageUrlStyle,
      servedFiles,
    }),
  );
}

/**
 * The Hosting redirect rules of a redirect plan (see
 * {@link firebaseRedirectsFromFile} for why 410 rows are left out). Also used
 * by the redirect sync on save (#1157), which builds the plan from the table
 * against the live version's files.
 */
export function firebaseRedirectsFromPlan(plan: RedirectPlan): FirebaseRedirect[] {
  return plan.redirects.map((r) => ({
    // The plan lists `/old` and `/old/`, or a single path (the root, a
    // file-like path); one anchored regex covers them.
    regex:
      r.matchPaths.length === 2
        ? `^${escapeRe2(r.fromPath)}/?$`
        : `^${r.matchPaths.map(escapeRe2).join("")}$`,
    location: r.location,
    statusCode: r.statusCode,
  }));
}

/**
 * True when a version's `config.redirects` (as the REST API returns it)
 * already equals `next`, field by field and in order — the sync then
 * creates no release. Order matters: Hosting applies the first match.
 */
export function sameFirebaseRedirects(
  current: readonly unknown[] | undefined,
  next: readonly FirebaseRedirect[],
): boolean {
  const canonical = (r: unknown): string => {
    const o = (r ?? {}) as Record<string, unknown>;
    return JSON.stringify([
      o.regex ?? null,
      o.glob ?? null,
      o.location ?? null,
      Number(o.statusCode),
    ]);
  };
  const a = (current ?? []).map(canonical);
  const b = next.map(canonical);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
