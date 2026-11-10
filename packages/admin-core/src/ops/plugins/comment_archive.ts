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
 *   comment_archive.stats_many    — #1169: how many approved comments
 *                                   each page has and when the last one
 *                                   was approved, in one read: the bake's
 *                                   count line and the signature that
 *                                   tells a build its bake went stale.
 *
 *   comment_archive.post_team     — #1329: an admin user's own comment,
 *                                   written straight as approved with the
 *                                   user as author, always top-level
 *                                   (#1529: no comment names a parent while
 *                                   threads are not shown). It never
 *                                   passes the public inbox, so no visitor
 *                                   can forge a post that looks like the
 *                                   team's; the projection publishes it to
 *                                   both public databases like a moderated
 *                                   comment.
 *
 * The read and insert ops run as the comments plugin's actor (or any system context).
 * Tier-1 plugin handlers reach them via `ctx.cms.call("comment_archive.*",
 * input)`.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { jsonbParam } from "../../sql-helpers.js";

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
  readScope: "request",
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

/** The most pages one read answers; the plugin splits a build's list. */
const MAX_STATS_PAGES = 500;

const statsManyInput = z
  .object({ pageIds: z.array(z.string().uuid()).min(1).max(MAX_STATS_PAGES) })
  .strict();

export const commentArchiveStatsManyOp = defineOperation({
  name: "comment_archive.stats_many",
  readScope: "request",
  actorScope: ["human", "ai", "system", "plugin"],
  database: "cms_admin",
  input: statsManyInput,
  output: z.object({
    /** Pages without an approved comment are absent. */
    stats: z.array(
      z.object({
        pageId: z.string(),
        approved: z.number().int(),
        lastArchivedAt: z.string(),
        /**
         * Which comments these are, in one order-independent value. Count
         * and newest instant alone stay put when one comment replaces
         * another below the newest.
         */
        fingerprint: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT page_id::text AS page_id, count(*)::int AS approved,
             max(archived_at)::text AS last_archived_at,
             sum(hashtextextended(id::text, 0)::numeric)::text AS fingerprint
      FROM comment_archive
      WHERE page_id IN (SELECT jsonb_array_elements_text(${jsonbParam(input.pageIds)})::uuid)
        AND status = 'approved'
      GROUP BY page_id
    `)) as unknown as {
      page_id: string;
      approved: number;
      last_archived_at: string;
      fingerprint: string;
    }[];
    return ok({
      stats: rows.map((r) => ({
        pageId: r.page_id,
        approved: r.approved,
        lastArchivedAt: r.last_archived_at,
        fingerprint: r.fingerprint,
      })),
    });
  },
});

const postTeamInput = z
  .object({
    pageId: z.string().uuid(),
    content: z.string().trim().min(1).max(50_000),
  })
  .strict();

export const commentArchivePostTeamOp = defineOperation({
  name: "comment_archive.post_team",
  readScope: "request",
  // Why human-only: the post is published under the signed-in user's own
  // name, as the team's words. An AI drafting the post hands the text to
  // the human, who posts it.
  actorScope: ["human"],
  database: "cms_admin",
  input: postTeamInput,
  output: z.object({ archiveId: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "comment_archive.post_team";
    const author = (await tx.execute(sql`
      SELECT display_name FROM actors WHERE id = ${ctx.actorId}::uuid AND kind = 'human'
    `)) as unknown as { display_name: string }[];
    const name = author[0]?.display_name;
    if (!name) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: "only a signed-in team member can post as the team",
      });
    }
    // A team post has no row in the public inbox; its public_row_id is its
    // own fresh id, so the archive's uniqueness still holds.
    const rows = (await tx.execute(sql`
      INSERT INTO comment_archive (
        public_row_id, page_id, author_name, content, status, submitted_at, posted_by
      ) VALUES (
        gen_random_uuid(), ${input.pageId}::uuid,
        ${name}, ${input.content}, 'approved', now(), ${ctx.actorId}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const archiveId = rows[0]?.id;
    if (!archiveId) throw new Error("comment_archive.post_team: insert returned no id");
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { pageId: input.pageId },
      succeeded: true,
      entityId: archiveId,
      resultSummary: `team post on page ${input.pageId}`,
    });
    return ok({ archiveId });
  },
});
