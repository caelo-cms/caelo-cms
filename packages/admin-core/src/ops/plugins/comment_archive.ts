// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.18 / Fix D — comment_archive ops.
 *
 *   comment_archive.insert        — promote one cms_public.plugin_comments
 *                                   row into the cms_admin archive. Called
 *                                   by the comments plugin's `moderate` /
 *                                   `bulk_moderate` handlers AFTER the
 *                                   public row's status flip succeeds.
 *                                   Idempotent via UNIQUE(public_row_id):
 *                                   ON CONFLICT DO NOTHING means a
 *                                   crash-and-retry doesn't double-archive.
 *
 *   comment_archive.list_for_page — read approved archived comments for
 *                                   one page (static bake + the visitor
 *                                   `list_approved`). Defined in
 *                                   @caelo-cms/plugin-host (gateway-ops.ts)
 *                                   because the API gateway runs it too.
 *
 * Both ops run as the comments plugin's actor (or any system context).
 * Tier-1 plugin handlers reach them via `ctx.cms.call("comment_archive.*",
 * input)`.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const insertInput = z
  .object({
    // The cms_public.plugin_comments.comments row id (uuid).
    publicRowId: z.string().uuid(),
    // page_id is a `pages.id` reference in production; comments
    // plugin's schema-from-spec declares it as "string" because the
    // emitter has no per-FK nuance, but values are uuids in real
    // installs. Validate as uuid here so a malformed test fixture
    // surfaces clearly instead of an opaque DB FK error.
    pageId: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    authorName: z.string().min(1).max(256),
    content: z.string().min(1).max(50_000),
    status: z.enum(["approved", "rejected", "spam"]),
    submittedAt: z.string().datetime(),
  })
  .strict();

export const commentArchiveInsertOp = defineOperation({
  name: "comment_archive.insert",
  // human + ai + system: human moderation through the admin UI; ai
  // moderation through the comments.ai_moderate handler; system from
  // any future cron / orchestrator. The op only writes the archive;
  // public-DB deletion is the responsibility of the calling plugin
  // op so the two writes (public delete + admin insert) sit inside
  // the same logical handler.
  actorScope: ["human", "ai", "system", "plugin"],
  database: "cms_admin",
  input: insertInput,
  output: z.object({ archiveId: z.string().nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO comment_archive (
        public_row_id, page_id, parent_id,
        author_name, content, status, submitted_at
      ) VALUES (
        ${input.publicRowId}::uuid,
        ${input.pageId}::uuid,
        ${input.parentId === null ? null : sql`${input.parentId}::uuid`},
        ${input.authorName},
        ${input.content},
        ${input.status},
        ${input.submittedAt}::timestamptz
      )
      ON CONFLICT (public_row_id) DO NOTHING
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    return ok({ archiveId: rows[0]?.id ?? null });
  },
});
