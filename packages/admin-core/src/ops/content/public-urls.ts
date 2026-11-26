// SPDX-License-Identifier: MPL-2.0

/**
 * #590 — `pages.resolve_public_urls`: core's public URL builder, offered
 * to plugins.
 *
 * A plugin that links to pages (international-site's hreflang, sitemap
 * alternates and language switcher) must emit exactly the URL the page's
 * canonical carries — same host, same trailing slash, same override. It
 * used to compose `base + current_path` itself and missed the deploy
 * target's trailing slash. Now it asks core, which answers through the
 * same `resolvePublicPageUrls` the static generator and the preview use
 * for canonical and the sitemap `<loc>`.
 */

import { type PublicUrlPage, resolvePublicPageUrls } from "@caelo-cms/plugin-host";
import {
  defineOperation,
  type QueryError,
  type TransactionRunner,
  uuidArray,
} from "@caelo-cms/query-api";
import {
  err,
  LIVE_BUILD_REFUSAL,
  type LiveBuildUrls,
  ok,
  PAGE_URL_STYLES,
  type PageUrlStyle,
  type Result,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { pageSeoViewSql } from "../../seo/page-seo.js";
import { renderScopeOf } from "./current-path.js";

/**
 * The page URL style of the target editor Publish goes to (the default
 * deploy target). The preview renders its URLs in this style so the
 * editor shows what the live site will carry. Null when no target is
 * marked default — the caller fails loudly with its own next step.
 */
export async function loadPublishPageUrlStyle(tx: TransactionRunner): Promise<PageUrlStyle | null> {
  const rows = (await tx.execute(sql`
    SELECT page_url_style FROM deploy_targets WHERE is_default LIMIT 1
  `)) as unknown as { page_url_style: PageUrlStyle }[];
  return rows[0]?.page_url_style ?? null;
}

export const resolvePublicUrlsOp = defineOperation({
  name: "pages.resolve_public_urls",
  readScope: "request",
  // Why system-only: a render-time building block, not an editing action.
  // Plugins call it from their head/sitemap/data-list operations, where
  // core hands them the serving target's `pageUrlStyle`; the AI reads a
  // page's URL from the page tools and the preview, which use the same
  // builder.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageIds: z.array(z.string().uuid()).min(1).max(1000),
      pageUrlStyle: z.enum(PAGE_URL_STYLES),
    })
    .strict(),
  output: z.object({ urls: z.record(z.string(), z.string()) }),
  handler: async (ctx, input, tx) => {
    // #1495 — a plugin-data build republishes into the live build, so it
    // links what that build shipped. main holds origins, paths and
    // canonicals nobody published.
    if (ctx.renderLiveUrls) return answerFromLiveBuild(ctx.renderLiveUrls, input.pageIds);
    // #650 — a plugin's call inside a static build gets the build's origin
    // (a Stage with its own staging host renders that host into the
    // canonical); the stored base URL would point its hreflang and
    // switcher links at the live site.
    const siteBaseUrl = ctx.renderSiteBaseUrl ?? (await storedSiteBaseUrl(tx));
    if (!siteBaseUrl) {
      // #551 — absolute URLs need the real public origin; a substituted
      // host would ship unreachable alternates.
      return err({
        kind: "HandlerError",
        operation: "pages.resolve_public_urls",
        message:
          "The site base URL is not configured, so page URLs (canonical, hreflang, language " +
          "links) cannot be built. Next step: the AI sets it with propose_set_site_seo(" +
          '{siteBaseUrl: "https://<public domain>"}) (Owner-approved), or a human sets it ' +
          "under Settings → SEO in the admin.",
      });
    }
    const pages = await loadPublicUrlPages(tx, ctx.chatBranchId, input.pageIds);
    const found = new Set(pages.map((p) => p.id));
    const missing = input.pageIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.resolve_public_urls",
        message: `no live page with id ${missing.join(", ")} — it was deleted or belongs to another chat's branch. Next step: re-read the page list and drop the stale id.`,
      });
    }
    const urls = await resolvePublicPageUrls(
      pages,
      { siteBaseUrl, pageUrlStyle: input.pageUrlStyle },
      renderScopeOf(ctx, tx),
    );
    return ok({ urls: Object.fromEntries(urls) });
  },
});

/**
 * What each page's public URL is built from (`resolvePublicPageUrls`), in
 * the caller's view: branch-aware like `pages.list`, so a chat sees main
 * plus its own creates and its pending canonical overrides. An id the view
 * does not hold (deleted, another chat's page, no page at all) is absent.
 * O(ids): the primary key and the SEO overlay of these ids.
 */
async function loadPublicUrlPages(
  tx: TransactionRunner,
  chatBranchId: string | null | undefined,
  pageIds: readonly string[],
): Promise<PublicUrlPage[]> {
  const branchFilter = chatBranchId
    ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${chatBranchId}::uuid)`
    : sql`p.chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT p.id::text AS id, p.slug, p.current_path, s.canonical_url
    FROM pages p
    LEFT JOIN ${pageSeoViewSql(chatBranchId, pageIds)} s ON s.page_id = p.id
    WHERE p.id = ANY(${uuidArray(pageIds)}) AND p.deleted_at IS NULL AND ${branchFilter}
  `)) as unknown as {
    id: string;
    slug: string;
    current_path: string;
    canonical_url: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    currentPath: r.current_path,
    canonicalOverride: r.canonical_url || null,
  }));
}

/**
 * #1729 — `pages.public_url_pages`: the inputs of these pages' public URLs
 * in the caller's view, for the plugin host. A plugin's head entry names a
 * page by id (docs/dev/external-plugin-brokers.md §6.2) and core builds its
 * URL with the builder that makes the page's canonical: this is the lookup
 * behind it, the same rows `pages.resolve_public_urls` reads. An id the
 * view does not hold is absent from the answer, so the host refuses the
 * one entry that names it instead of the whole render.
 */
export const publicUrlPagesOp = defineOperation({
  name: "pages.public_url_pages",
  readScope: "request",
  // Why system-only: the plugin host's lookup at render time (preview on
  // the chat's branch, build on main). A plugin asks
  // pages.resolve_public_urls; the AI reads URLs from the page tools.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ pageIds: z.array(z.string().uuid()).min(1).max(1000) }).strict(),
  output: z.object({
    pages: z.array(
      z
        .object({
          id: z.string(),
          slug: z.string(),
          currentPath: z.string(),
          canonicalOverride: z.string().nullable(),
        })
        .strict(),
    ),
  }),
  handler: async (ctx, input, tx) =>
    ok({ pages: await loadPublicUrlPages(tx, ctx.chatBranchId, input.pageIds) }),
});

/**
 * The URLs the live build shipped. A page it does not ship is recorded on
 * `live`, which holds the whole region back even when the plugin catches
 * this error and renders on.
 */
function answerFromLiveBuild(
  live: LiveBuildUrls,
  pageIds: readonly string[],
): Result<{ urls: Record<string, string> }, QueryError> {
  const urls: Record<string, string> = {};
  for (const id of pageIds) {
    const url = live.urls.get(id);
    if (url === undefined) live.unknownPageIds.add(id);
    else urls[id] = url;
  }
  if (live.unknownPageIds.size > 0) {
    return err({
      kind: "HandlerError",
      operation: "pages.resolve_public_urls",
      message: `${LIVE_BUILD_REFUSAL} the live build ships no page with id ${[...live.unknownPageIds].join(", ")}, so this render cannot link it. The region keeps its published output until the next Publish live.`,
    });
  }
  return ok({ urls });
}

/** `site_defaults.site_base_url`, or null while it is unset (#551). */
async function storedSiteBaseUrl(tx: TransactionRunner): Promise<string | null> {
  const base = (await tx.execute(sql`
    SELECT site_base_url FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { site_base_url: string | null }[];
  return base[0]?.site_base_url ?? null;
}
