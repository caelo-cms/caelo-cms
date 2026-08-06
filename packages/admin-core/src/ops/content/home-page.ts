// SPDX-License-Identifier: MPL-2.0

/**
 * 0184 — explicit HOMEPAGE designation.
 *
 * `pages.set_home_page` records `site_defaults.home_page_id` so ANY
 * page can be the site root — keeping its own slug — instead of the
 * root being decided implicitly by a magic slug (""/`home`/`index`).
 * One root per site: setting it replaces any prior designation.
 * (Epic #380 #384: the pointer moved here from the deleted locales
 * table — the homepage is core routing, not an i18n concern.)
 *
 * This is a CONTENT decision, so it is AI-settable
 * (`human + ai + system`). It has no cross-page fan-out — it flips a
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
  // behalf ("this page is the homepage").
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }).strict(),
  output: z.object({ pageId: z.string() }),
  handler: async (ctx, input, tx) => {
    // Branch-aware so a page created on THIS chat's branch can be
    // designated in the same session.
    const branchFilter = branchVisibilityFilter(ctx);
    const pageRows = (await tx.execute(sql`
      SELECT 1 AS found FROM pages
      WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL ${branchFilter}
      LIMIT 1
    `)) as unknown as { found: number }[];
    if (!pageRows[0]) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_home_page",
        message: "page not found or deleted — pass a live page id from list_pages",
      });
    }
    // Fail loudly if the singleton row is missing (no silent no-op
    // UPDATE — CLAUDE.md §2 no-fallbacks). RETURNING confirms the write.
    const updated = (await tx.execute(sql`
      UPDATE site_defaults
         SET home_page_id = ${input.pageId}::uuid,
             updated_at = now()
       WHERE id = 1
       RETURNING id
    `)) as unknown as { id: number }[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_home_page",
        message:
          "site_defaults singleton row is missing — the install is not seeded (run migrations)",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.set_home_page",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: "home designated",
    });
    return ok({ pageId: input.pageId });
  },
});
