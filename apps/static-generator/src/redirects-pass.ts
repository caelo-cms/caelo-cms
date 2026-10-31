// SPDX-License-Identifier: MPL-2.0

/**
 * Write the redirects table into the build (#587).
 *
 * - `_redirects` — the table dump (`<from> <to> <status>` per line). The
 *   cloud publishers read it and build the redirect plan against the build
 *   they deploy (Firebase Hosting config, GCP URL map, …).
 * - `_redirects.cloudflare` — the same content under the name Cloudflare
 *   Pages / Netlify operators look for.
 * - `_redirects.caddy` — the plan as a Caddyfile snippet the self-hosted
 *   site blocks import (redirect-emit-caddy.ts in @caelo-cms/shared).
 *
 * #1157 — a redirects save also puts the table live without a build
 * (admin-core deploy/redirect-sync.ts); the copies here are what a build
 * carries, and Publish live re-syncs the table as saved now.
 *
 * Runs after every other file of the build is written: the plan leaves out
 * rows whose from path a build file serves (the live page wins), so it needs
 * the complete file list — the paths the build wrote and references.
 */

import {
  buildRedirectPlan,
  CADDY_REDIRECTS_FILE,
  emitCaddyRedirects,
  formatRedirectsFile,
  type RedirectPageUrlStyle,
  type RedirectTableRow,
} from "@caelo-cms/shared";

/**
 * The redirect files of a build, for the generator to write with the rest.
 *
 * @throws when a row cannot be served (see `buildRedirectPlan`).
 */
export function redirectFiles(args: {
  readonly rows: readonly RedirectTableRow[];
  readonly pageUrlStyle: RedirectPageUrlStyle;
  /** Every path the build serves (#1271: known without reading the build directory). */
  readonly servedFiles: ReadonlySet<string>;
}): { name: string; content: string }[] {
  const table = formatRedirectsFile(args.rows);
  const plan = buildRedirectPlan({
    rows: args.rows,
    pageUrlStyle: args.pageUrlStyle,
    servedFiles: args.servedFiles,
  });
  return [
    { name: "_redirects", content: table },
    { name: "_redirects.cloudflare", content: table },
    { name: CADDY_REDIRECTS_FILE, content: emitCaddyRedirects(plan) },
  ];
}
