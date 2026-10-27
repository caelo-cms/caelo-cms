// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — which plugin bakes are stale (`plugin_data_stale_pages`).
 *
 * A plugin declares the operations that change what its `staticRender`
 * bakes into pages (plugin SDK `bakedData`). When one succeeds, the host
 * marks the pages it names; the next plugin-data build re-bakes them in
 * the build that is live (plugin-data/build.ts). Marks come from two
 * places:
 *
 *   - `operation`: the admin's own call of the trigger (the Owner's or the
 *     AI's moderation click), dispatched by the admin's plugin host;
 *   - `visitor`: a visitor op event the gateway recorded in cms_public,
 *     read back as an UNTRUSTED hint (plugin-data/visitor-hints.ts).
 *
 * Either way a mark is only a reason to re-render from authoritative
 * state. It changes nothing in cms_admin a page shows, and a page id
 * counts only when it names a main-line page that exists.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { uuidList } from "./quality/_shared.js";

export const markPluginDataPagesOp = defineOperation({
  name: "plugin_data.mark_pages",
  // Why human-only: the plugin host's own bookkeeping after a declared
  // trigger succeeded (or a validated visitor hint). Nobody decides it, and
  // a mark only schedules a re-render of what is already published.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      pluginId: z.string().uuid(),
      pageIds: z.array(z.string().uuid()).min(1).max(1000),
      source: z.enum(["operation", "visitor"]),
    })
    .strict(),
  output: z.object({
    /** Pages marked stale (now pending for the next plugin-data build). */
    marked: z.number().int(),
    /** Ids that name no main-line page, or a plugin that is not active. */
    ignored: z.number().int(),
  }),
  handler: async (_ctx, input, tx) => {
    const ids = [...new Set(input.pageIds.map((id) => id.toLowerCase()))];
    const active = (await tx.execute(sql`
      SELECT 1 AS ok FROM plugins WHERE id = ${input.pluginId}::uuid AND status = 'active'
    `)) as unknown as unknown[];
    if (active.length === 0) return ok({ marked: 0, ignored: ids.length });
    // clock_timestamp(), not now(): the mark must be later than the commit
    // of the data it announces, which happened before this transaction.
    const rows = (await tx.execute(sql`
      INSERT INTO plugin_data_stale_pages (plugin_id, page_id, first_marked_at, last_marked_at,
                                           last_source)
      SELECT ${input.pluginId}::uuid, p.id, clock_timestamp(), clock_timestamp(), ${input.source}
      FROM pages p
      WHERE p.id = ANY(${uuidList(ids)})
        AND p.deleted_at IS NULL
        AND p.chat_branch_id IS NULL
      ON CONFLICT (plugin_id, page_id) DO UPDATE
        SET last_marked_at = clock_timestamp(), last_source = EXCLUDED.last_source
      RETURNING page_id
    `)) as unknown as unknown[];
    return ok({ marked: rows.length, ignored: ids.length - rows.length });
  },
});
