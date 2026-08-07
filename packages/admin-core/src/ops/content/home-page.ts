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
 * (`human + ai + system`). Its URL effect is bounded to two pages (the
 * new home composes to "/", the previous one back to its slug shape —
 * both recomputed here, #390), so it needs no propose/execute gate
 * (§11.A: one tool call undoes it).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";
import { recomputeCurrentPaths } from "./current-path.js";

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
    // Capture the previous designation BEFORE the flip — its page's
    // composed path changes back from "/" to its slug shape (#390).
    const prevRows = (await tx.execute(sql`
      SELECT home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1
    `)) as unknown as { home_page_id: string | null }[];
    const previousHomeId = prevRows[0]?.home_page_id ?? null;
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
    // #390 — the designation flip moves the root. Recompute order is
    // load-bearing: every page CURRENTLY at "/" (the previous
    // designation, or a magic-slug page from before a designation
    // existed) must vacate the root BEFORE the new home claims it, or
    // the current_path uniqueness index rejects the flip mid-tx.
    const rootHolders = (await tx.execute(sql`
      SELECT id::text AS id FROM pages
      WHERE current_path = '/' AND deleted_at IS NULL AND id != ${input.pageId}::uuid
    `)) as unknown as { id: string }[];
    const affected = [
      ...rootHolders.map((r) => r.id),
      ...(previousHomeId && previousHomeId !== input.pageId ? [previousHomeId] : []),
      input.pageId,
    ];
    await recomputeCurrentPaths(tx, affected);
    return ok({ pageId: input.pageId });
  },
});
