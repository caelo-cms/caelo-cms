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

import { resolvePublicPageUrls } from "@caelo-cms/plugin-host";
import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok, PAGE_URL_STYLES, type PageUrlStyle } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
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
    const base = (await tx.execute(sql`
      SELECT site_base_url FROM site_defaults WHERE id = 1 LIMIT 1
    `)) as unknown as { site_base_url: string | null }[];
    const siteBaseUrl = base[0]?.site_base_url;
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
          "under Security → SEO in the admin.",
      });
    }
    const idList = sql.join(
      input.pageIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    // Branch-aware like pages.list: a chat sees main plus its own creates.
    const branchFilter = ctx.chatBranchId
      ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`p.chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT p.id::text AS id, p.slug, p.current_path, s.canonical_url
      FROM pages p
      LEFT JOIN pages_seo s ON s.page_id = p.id
      WHERE p.id IN (${idList}) AND p.deleted_at IS NULL AND ${branchFilter}
    `)) as unknown as {
      id: string;
      slug: string;
      current_path: string;
      canonical_url: string | null;
    }[];
    const found = new Set(rows.map((r) => r.id));
    const missing = input.pageIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.resolve_public_urls",
        message: `no live page with id ${missing.join(", ")} — it was deleted or belongs to another chat's branch. Next step: re-read the page list and drop the stale id.`,
      });
    }
    const urls = await resolvePublicPageUrls(
      rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        currentPath: r.current_path,
        canonicalOverride: r.canonical_url || null,
      })),
      { siteBaseUrl, pageUrlStyle: input.pageUrlStyle },
      renderScopeOf(ctx),
    );
    return ok({ urls: Object.fromEntries(urls) });
  },
});
