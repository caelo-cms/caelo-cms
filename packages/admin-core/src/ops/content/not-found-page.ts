// SPDX-License-Identifier: MPL-2.0

/**
 * 0284 (#802) — explicit NOT-FOUND (404) page designation.
 *
 * `pages.set_not_found_page` records `site_defaults.not_found_page_id`.
 * The static generator renders that page through its normal template +
 * layout (header, footer, theme, fonts) and emits it as `/404.html`,
 * which every provider serves for unknown URLs with status 404. The page
 * is never emitted at its own path: a 200 copy of an error page is a
 * soft-404.
 *
 * Mirrors `pages.set_home_page`: a CONTENT decision ("this page is what
 * visitors see on a broken link"), so it is AI-settable
 * (`human + ai + system`). One call undoes it (designate another page or
 * pass `pageId: null`), so it needs no propose/execute gate (§11.A).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";

export const setNotFoundPageOp = defineOperation({
  name: "pages.set_not_found_page",
  // CLAUDE.md §11 — a content decision the AI makes on the operator's
  // behalf ("use this page for broken links").
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid().nullable() }).strict(),
  output: z.object({ pageId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    if (input.pageId !== null) {
      // Branch-aware so a page created on THIS chat's branch can be
      // designated in the same session (same rule as set_home_page).
      const branchFilter = branchVisibilityFilter(ctx);
      const pageRows = (await tx.execute(sql`
        SELECT current_path FROM pages
        WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL ${branchFilter}
        LIMIT 1
      `)) as unknown as { current_path: string | null }[];
      const page = pageRows[0];
      if (!page) {
        return err({
          kind: "HandlerError",
          operation: "pages.set_not_found_page",
          message: "page not found or deleted — pass a live page id from list_pages",
        });
      }
      // The homepage serves "/"; as the 404 page it would vanish from the
      // root (the generator emits the 404 page only as /404.html).
      const homeRows = (await tx.execute(sql`
        SELECT 1 AS is_home FROM site_defaults
        WHERE id = 1 AND home_page_id = ${input.pageId}::uuid
        LIMIT 1
      `)) as unknown as { is_home: number }[];
      if (homeRows.length > 0 || page.current_path === "/") {
        return err({
          kind: "HandlerError",
          operation: "pages.set_not_found_page",
          message:
            "this page is the homepage and serves at '/', so it cannot also be the 404 page — build a separate page for unknown URLs (build_page, e.g. title 'Page not found' with a link back home) and designate that one",
        });
      }
    }
    // Fail loudly if the singleton row is missing (no silent no-op
    // UPDATE — CLAUDE.md §2 no-fallbacks). RETURNING confirms the write.
    const updated = (await tx.execute(sql`
      UPDATE site_defaults
         SET not_found_page_id = ${input.pageId}::uuid,
             updated_at = now()
       WHERE id = 1
       RETURNING id
    `)) as unknown as { id: number }[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "pages.set_not_found_page",
        message:
          "site_defaults singleton row is missing — the install is not seeded (run migrations)",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.set_not_found_page",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: input.pageId !== null ? "404 page designated" : "404 page cleared",
    });
    return ok({ pageId: input.pageId });
  },
});
