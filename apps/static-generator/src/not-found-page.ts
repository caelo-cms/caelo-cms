// SPDX-License-Identifier: MPL-2.0

/**
 * #802 — the site's own 404 page.
 *
 * Every provider answers an unknown URL from a fixed `/404.html` with
 * status 404: Firebase Hosting by convention, the GCS bucket website's
 * `notFoundPage`, CloudFront's custom error responses, Azure's
 * `error404Document`, Caddy's `handle_errors`. The page designated as
 * `site_defaults.not_found_page_id` is composed like every other page
 * (template, layout, theme, fonts, media, plugins) and written to that
 * file INSTEAD of its own path: a 200 copy at `/<slug>` would be a
 * soft-404 search engines index.
 *
 * Its asset URLs are root-absolute (`/_assets/…`, `/_caelo/plugin/…`),
 * so the same file renders correctly whatever depth the missing URL had.
 *
 * No designation = no `404.html`, deliberately: the host's generic page
 * stays and the AI's site status line names the gap (see
 * `buildStatusLine`). Failing every build until a 404 page exists would
 * block Stage on every existing site for a cosmetic gap.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** The file every provider serves for unknown URLs. */
export const NOT_FOUND_PAGE_FILE = "404.html";

/**
 * A designated 404 page missing from a full staging/production build is
 * a draft (or a deleted/branch-only page): shipping without it would
 * silently put the host's generic page back. Fail loudly with the fix
 * (CLAUDE.md §2). Incremental builds and `dev` are exempt, like the
 * other whole-site guards in generate.ts.
 *
 * @returns the error message to throw, or null when the build may proceed.
 */
export function notFoundPageBuildError(args: {
  notFoundPageId: string | null;
  builtPageIds: readonly string[];
  env: "dev" | "staging" | "production";
  incremental: boolean;
}): string | null {
  if (args.notFoundPageId === null || args.env === "dev" || args.incremental) return null;
  if (args.builtPageIds.includes(args.notFoundPageId)) return null;
  return (
    `static-generator: the designated 404 page (${args.notFoundPageId}) is not part of this ${args.env} build — it is still a draft, or it was deleted. ` +
    "Without it unknown URLs would show the hosting provider's generic error page. " +
    "Publish it (AI: `set_pages_status_many` with status 'published'; UI: the page's status toggle in /edit), " +
    "or designate another published page (AI: `set_not_found_page`), or clear the designation (`set_not_found_page` with pageId null), then re-run the deploy."
  );
}

/** Read `site_defaults.not_found_page_id` (null when none is designated). */
export async function readNotFoundPageId(tx: TransactionRunner): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT not_found_page_id::text AS not_found_page_id FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { not_found_page_id: string | null }[];
  return rows[0]?.not_found_page_id ?? null;
}
