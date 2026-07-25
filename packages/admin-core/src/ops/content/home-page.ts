// SPDX-License-Identifier: MPL-2.0

/**
 * 0184 — explicit per-locale HOMEPAGE designation.
 *
 * `pages.set_home_page` records `locales.home_page_id` so ANY page can be
 * the site root (per locale, the locale root `/`) — keeping its own slug —
 * instead of the root being decided implicitly by a magic slug
 * (""/`home`/`index`). One root per locale: setting it replaces any prior
 * designation for that locale.
 *
 * This is a CONTENT decision, not a URL-strategy change, so it is
 * AI-settable (`human + ai + system`) and NOT admin-gated like the
 * locale url_strategy ops. It has no cross-page fan-out — it flips a
 * single pointer — so it needs no propose/execute gate (§11.A).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";

export const setHomePageOp = defineOperation({
  name: "pages.set_home_page",
  // CLAUDE.md §11 — a content decision the AI makes on the operator's
  // behalf ("this page is the homepage"), not the admin-only url_strategy.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      /** Locale to set the root for; defaults to the page's own locale. */
      locale: z.string().min(2).max(10).optional(),
    })
    .strict(),
  output: z.object({ pageId: z.string(), locale: z.string() }),
  handler: async (ctx, input, tx) => {
    // Branch-aware so a page created on THIS chat's branch can be
    // designated in the same session.
    const branchFilter = branchVisibilityFilter(ctx);
    const pageRows = (await tx.execute(sql`
      SELECT locale FROM pages
      WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL ${branchFilter}
      LIMIT 1
    `)) as unknown as { locale: string }[];
    const page = pageRows[0];
    if (!page) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_home_page",
        message: "page not found or deleted — pass a live page id from list_pages",
      });
    }
    const locale = input.locale ?? page.locale;
    // Fail loudly if the target locale doesn't exist (no silent no-op UPDATE
    // — CLAUDE.md §2 no-fallbacks). RETURNING confirms the write landed.
    const updated = (await tx.execute(sql`
      UPDATE locales
         SET home_page_id = ${input.pageId}::uuid,
             updated_at = now()
       WHERE code = ${locale}
       RETURNING code
    `)) as unknown as { code: string }[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_home_page",
        message: `locale "${locale}" is not configured — add it under /security/locales, or pass a locale that exists (list via list_locales)`,
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.set_home_page",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `locale=${locale}`,
    });
    return ok({ pageId: input.pageId, locale });
  },
});
