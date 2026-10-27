// SPDX-License-Identifier: MPL-2.0

/**
 * The redirect plan: what every serving layer answers for the rows of the
 * `redirects` table (#587).
 *
 * Each provider serves redirects through its own edge mechanism (Caddy
 * `map` + `redir`, a GCP URL map, Firebase Hosting `config.redirects`, a
 * CloudFront Function with a KeyValueStore, Front Door rules). They all
 * consume this one plan, so a redirect means the same thing on every
 * provider:
 *
 * - **Exact paths.** A row matches its `from` path exactly (case-sensitive)
 *   and the same path with a trailing slash — in the directory page style
 *   `/old/` is the URL people link to. A from path whose last segment
 *   looks like a file (`/old.html`) matches only as written.
 * - **The build wins.** A row whose from path a file of the build serves
 *   is left out (#575): a live page always beats a recorded redirect, as
 *   in the admin's 404 fallback (`redirects.lookup`). The edge layers
 *   evaluate redirects BEFORE static files, so without this a slug moved
 *   back to its old path would be shadowed (or loop with the reverse row).
 * - **Chains collapse.** `/a → /b` plus `/b → /c` serves `/a → /c` in one
 *   hop; crawlers follow few hops and every hop costs a round-trip. A hop
 *   is followed only through rows that are themselves in the plan. The
 *   collapsed status is permanent only when every hop is, and preserves
 *   the method (307/308) only when every hop does.
 * - **Loops fail the build.** A cycle can only ever answer "too many
 *   redirects"; the error names it.
 * - **Location.** In the directory style a page's canonical URL ends in
 *   `/`; the Location points there directly (the host would otherwise add
 *   a second hop). The visitor's query string is carried over unless the
 *   target has its own query or fragment.
 * - **410.** Rows with status 410 become `gone` entries. Layers that can
 *   answer a bare status (Caddy, CloudFront) send 410; the others answer
 *   the 404 a path without a file gets anyway.
 */

import { redirectTargetIssue } from "./redirect-target.js";
import { trimTrailingSlashes } from "./url.js";

/** The redirect statuses the redirects table stores (besides 410). */
export type RedirectStatusCode = 301 | 302 | 307 | 308;

/** A row of the redirects table, as the static generator dumps it. */
export interface RedirectTableRow {
  readonly fromPath: string;
  readonly toPath: string;
  readonly statusCode: number;
}

/** How the deploy target emits page URLs (`DeployTarget.pageUrlStyle`). */
export type RedirectPageUrlStyle = "directory" | "no-extension";

/** One redirect the serving layer answers. */
export interface PlannedRedirect {
  /** The stored from path without a trailing slash (`/` for the root). */
  readonly fromPath: string;
  /** Every request path this entry answers, exactly (`/old`, `/old/`). */
  readonly matchPaths: readonly string[];
  /** The Location header value (a same-site path, see module comment). */
  readonly location: string;
  readonly statusCode: RedirectStatusCode;
  /** Append the request's query string to {@link location}. */
  readonly preserveQuery: boolean;
}

/** One path the serving layer answers with 410 Gone (where it can). */
export interface PlannedGone {
  readonly fromPath: string;
  readonly matchPaths: readonly string[];
}

/** Everything a serving layer needs to answer the redirects table. */
export interface RedirectPlan {
  readonly redirects: readonly PlannedRedirect[];
  readonly gone: readonly PlannedGone[];
  /** From paths left out because a build file serves them (#575). */
  readonly shadowedByBuild: readonly string[];
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308]);
const GONE_STATUS = 410;

/**
 * Parse the generator's `_redirects` file (`<from> <to> <status>` per line,
 * `#` comments). Throws on a malformed line — a rule silently dropped is a
 * 404 on a URL someone links to.
 *
 * @example
 *   parseRedirectsFile("# generated\n/old /new 301\n")
 *   // → [{ fromPath: "/old", toPath: "/new", statusCode: 301 }]
 */
export function parseRedirectsFile(text: string): RedirectTableRow[] {
  const rows: RedirectTableRow[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(" ");
    const [fromPath, toPath, status] = parts;
    const statusCode = Number(status);
    if (parts.length !== 3 || !fromPath || !toPath || !Number.isInteger(statusCode)) {
      throw new Error(
        `redirect-plan: _redirects line ${index + 1} is not "<from> <to> <status>": ${JSON.stringify(raw)}. The static generator writes this file from the redirects table — fix the row there (find_redirects / bulk_create_redirects) and rebuild.`,
      );
    }
    rows.push({ fromPath, toPath, statusCode });
  }
  return rows;
}

/**
 * Serialise rows into the `_redirects` file format {@link parseRedirectsFile}
 * reads (also the Netlify / Cloudflare Pages format).
 */
export function formatRedirectsFile(rows: readonly RedirectTableRow[]): string {
  return [
    "# Auto-generated by Caelo static-generator. Do not edit by hand.",
    ...rows.map((r) => `${r.fromPath} ${r.toPath} ${r.statusCode}`),
    "",
  ].join("\n");
}

/** Arguments of {@link buildRedirectPlan}. */
export interface BuildRedirectPlanArgs {
  readonly rows: readonly RedirectTableRow[];
  readonly pageUrlStyle: RedirectPageUrlStyle;
  /**
   * Every file of the build, relative to the build root without a leading
   * slash (`de/preise/index.html`). A from path one of them serves is left
   * out of the plan.
   */
  readonly servedFiles: ReadonlySet<string>;
}

interface NormalisedRow {
  readonly bare: string;
  readonly toPath: string;
  readonly statusCode: number;
}

/**
 * Build the redirect plan every provider serves (see the module comment for
 * the semantics). Pure and deterministic: entries keep the rows' order.
 * Throws with an actionable message on rows no edge layer can serve
 * correctly — a malformed path, an unsafe target, conflicting duplicates, a
 * loop.
 */
export function buildRedirectPlan(args: BuildRedirectPlanArgs): RedirectPlan {
  const rows = normaliseRows(args.rows);
  const shadowedByBuild: string[] = [];
  const live = new Map<string, NormalisedRow>();
  for (const row of rows) {
    if (servedByBuild(row.bare, args.servedFiles)) {
      shadowedByBuild.push(row.bare);
      continue;
    }
    live.set(row.bare, row);
  }

  const redirects: PlannedRedirect[] = [];
  const gone: PlannedGone[] = [];
  for (const row of live.values()) {
    const matchPaths = matchPathsFor(row.bare);
    if (row.statusCode === GONE_STATUS) {
      gone.push({ fromPath: row.bare, matchPaths });
      continue;
    }
    const { target, statusCode } = collapseChain(row, live);
    const location = locationFor(target, args.pageUrlStyle);
    redirects.push({
      fromPath: row.bare,
      matchPaths,
      location,
      statusCode,
      preserveQuery: !/[?#]/.test(location),
    });
  }
  return { redirects, gone, shadowedByBuild };
}

/**
 * The planned redirects whose Location is a same-site path the build does
 * not serve (#1157). Redirects reach the live site on save, pages only with
 * Publish live, so a redirect to a page that is still a draft answers 404 at
 * its target until that page is published. Callers report these; they are
 * not an error. Paths under `/api/` are answered by the gateway, not the
 * build, and are never reported.
 *
 * @example
 *   redirectsToUnservedPaths(plan, new Set(["index.html"]))
 *   // → the entries of `plan.redirects` pointing anywhere but `/`
 */
export function redirectsToUnservedPaths(
  plan: RedirectPlan,
  servedFiles: ReadonlySet<string>,
): PlannedRedirect[] {
  return plan.redirects.filter((r) => {
    const path = pathBeforeQuery(r.location);
    if (path === "/api" || path.startsWith("/api/")) return false;
    if (looksLikeFile(path)) return !servedFiles.has(path.slice(1));
    return !servedByBuild(stripTrailingSlash(path), servedFiles);
  });
}

function normaliseRows(rows: readonly RedirectTableRow[]): NormalisedRow[] {
  const byBare = new Map<string, NormalisedRow>();
  const out: NormalisedRow[] = [];
  for (const row of rows) {
    const { fromPath, toPath, statusCode } = row;
    const shown = JSON.stringify(fromPath);
    if (!fromPath.startsWith("/") || /[\s\p{Cc}]/u.test(fromPath)) {
      throw new Error(
        `redirect-plan: from path ${shown} must start with '/' and contain no whitespace or control characters. Fix the row with bulk_create_redirects (upsert) or delete it with bulk_delete_redirects, then rebuild.`,
      );
    }
    if (/[?#]/.test(fromPath)) {
      throw new Error(
        `redirect-plan: from path ${shown} contains '?' or '#'. Redirects match the URL path only, so this row can never match. Re-create it for the path alone (e.g. '${pathBeforeQuery(fromPath)}') or delete it with bulk_delete_redirects, then rebuild.`,
      );
    }
    if (statusCode !== GONE_STATUS && !REDIRECT_STATUSES.has(statusCode)) {
      throw new Error(
        `redirect-plan: the redirect for ${shown} has status ${statusCode}; the redirects table allows 301, 302, 307, 308 or 410. Fix the row and rebuild.`,
      );
    }
    if (statusCode !== GONE_STATUS) {
      const targetIssue = redirectTargetIssue(toPath);
      if (targetIssue) throw new Error(`redirect-plan: the redirect for ${shown}: ${targetIssue}`);
    }
    const bare = stripTrailingSlash(fromPath);
    const normalised: NormalisedRow = { bare, toPath, statusCode };
    const existing = byBare.get(bare);
    if (existing) {
      if (existing.toPath === toPath && existing.statusCode === statusCode) continue;
      throw new Error(
        `redirect-plan: two redirects answer ${JSON.stringify(bare)} (with and without the trailing slash) differently: → ${existing.toPath} (${existing.statusCode}) and → ${toPath} (${statusCode}). Delete one with bulk_delete_redirects, then rebuild.`,
      );
    }
    byBare.set(bare, normalised);
    out.push(normalised);
  }
  return out;
}

/** Follow `row`'s target through the plan's own rows to the final hop. */
function collapseChain(
  row: NormalisedRow,
  live: ReadonlyMap<string, NormalisedRow>,
): { target: string; statusCode: RedirectStatusCode } {
  const visited = [row.bare];
  let target = row.toPath;
  let permanent = isPermanent(row.statusCode);
  let preservesMethod = preservesRequestMethod(row.statusCode);
  for (;;) {
    // A target with its own query or fragment is a different URL than the
    // path the next row matches; the chain ends there.
    if (/[?#]/.test(target)) break;
    const next = live.get(stripTrailingSlash(target));
    if (!next || next.statusCode === GONE_STATUS) break;
    if (visited.includes(next.bare)) {
      const cycle = [...visited.slice(visited.indexOf(next.bare)), next.bare].join(" → ");
      throw new Error(
        `redirect-plan: the redirects ${cycle} form a loop, which browsers answer with "too many redirects". Delete the row that should no longer apply with bulk_delete_redirects (find_redirects lists them), then rebuild.`,
      );
    }
    visited.push(next.bare);
    permanent &&= isPermanent(next.statusCode);
    preservesMethod &&= preservesRequestMethod(next.statusCode);
    target = next.toPath;
  }
  return { target, statusCode: combinedStatus(permanent, preservesMethod) };
}

function isPermanent(status: number): boolean {
  return status === 301 || status === 308;
}

function preservesRequestMethod(status: number): boolean {
  return status === 307 || status === 308;
}

function combinedStatus(permanent: boolean, preservesMethod: boolean): RedirectStatusCode {
  if (permanent) return preservesMethod ? 308 : 301;
  return preservesMethod ? 307 : 302;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? trimTrailingSlashes(path) || "/" : path;
}

/** The part of a stored path before its first `?` or `#` (`/` if empty). */
function pathBeforeQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return (cut === -1 ? path : path.slice(0, cut)) || "/";
}

/** Whether the last path segment names a file (`/a/b.html`). */
function looksLikeFile(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1).includes(".");
}

function matchPathsFor(bare: string): readonly string[] {
  if (bare === "/" || looksLikeFile(bare)) return [bare];
  return [bare, `${bare}/`];
}

/** Does a file of the build answer `bare`? Hosts serve `/x` from the file
 *  `x` and from the directory index `x/index.html`. */
function servedByBuild(bare: string, servedFiles: ReadonlySet<string>): boolean {
  if (bare === "/") return servedFiles.has("index.html");
  const rel = bare.slice(1);
  return servedFiles.has(rel) || servedFiles.has(`${rel}/index.html`);
}

/** In the directory style, internal page paths end in "/"; files (anything
 *  with an extension in its last segment) and URLs with a query or fragment
 *  stay as they are. */
function locationFor(toPath: string, pageUrlStyle: RedirectPageUrlStyle): string {
  if (pageUrlStyle !== "directory" || toPath.endsWith("/")) return toPath;
  if (/[?#]/.test(toPath) || looksLikeFile(toPath)) return toPath;
  return `${toPath}/`;
}
