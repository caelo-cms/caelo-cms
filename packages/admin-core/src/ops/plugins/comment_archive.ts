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

import { importedCommentsClause } from "@caelo-cms/plugin-host";
import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
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
  pluginAccess: "write",
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
  pluginAccess: "read",
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
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT page_id::text AS page_id, count(*)::int AS approved,
             max(archived_at)::text AS last_archived_at,
             sum(hashtextextended(id::text, 0)::numeric)::text AS fingerprint
      FROM comment_archive
      WHERE page_id IN (SELECT jsonb_array_elements_text(${jsonbParam(input.pageIds)})::uuid)
        AND status = 'approved'
        ${importedCommentsClause(ctx.renderImportView)}
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

/** Most comments one `comment_archive.import_many` call writes. */
const MAX_IMPORT_COMMENTS = 500;

const importManyInput = z
  .object({
    importId: z.string().uuid(),
    comments: z
      .array(
        z
          .object({
            /** The import row's id (data-imports/ids.ts): the archive row's id and public id. */
            id: z.string().uuid(),
            pageId: z.string().uuid(),
            parentId: z.string().uuid().nullable(),
            authorName: z.string().min(1).max(256),
            content: z.string().min(1).max(50_000),
            submittedAt: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_IMPORT_COMMENTS),
  })
  .strict();

/** The import, when the calling plugin owns it and it is still open; else the refusal. */
async function ownImport(
  tx: TransactionRunner,
  ctx: { pluginId?: string },
  importId: string,
  op: string,
  needUndone: boolean,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT di.undone_at IS NOT NULL AS undone, p.slug
    FROM data_imports di LEFT JOIN plugins p ON p.id = ${ctx.pluginId ?? null}::uuid
    WHERE di.id = ${importId}::uuid AND di.owner = 'comments' AND di.kind = 'comments'
  `)) as unknown as { undone: boolean; slug: string | null }[];
  const row = rows[0];
  if (!row) return `${op}: ${importId} is not an import of comments`;
  if (row.slug !== "comments") return `${op}: only the comments plugin writes its imports`;
  if (row.undone !== needUndone)
    return `${op}: import ${importId} ${needUndone ? "is not undone" : "was undone"}`;
  return null;
}

/**
 * Data imports (docs/data-imports.md) — the comments plugin's apply
 * operation stores an import's comments here: approved, with their
 * original date as the thread position (`archived_at`), tagged with the
 * import so every read shows them only where the import is released. A
 * retried call overwrites the rows it wrote (same ids).
 */
export const commentArchiveImportManyOp = defineOperation({
  name: "comment_archive.import_many",
  pluginAccess: "write",
  readScope: "request",
  // Why human-only: only the comments plugin's import apply operation
  // writes imported comments (import_comments runs it); people and the AI
  // import through that tool, never straight into the archive.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: importManyInput,
  output: z.object({ written: z.number().int() }),
  handler: async (ctx, input, tx) => {
    const op = "comment_archive.import_many";
    const refusal = await ownImport(tx, ctx, input.importId, op, false);
    if (refusal) return err({ kind: "HandlerError", operation: op, message: refusal });
    const rows = (await tx.execute(sql`
      INSERT INTO comment_archive (
        id, public_row_id, page_id, parent_id, author_name, content, status, submitted_at,
        archived_at, data_import_id
      )
      SELECT c.id, c.id, c."pageId", c."parentId", c."authorName", c.content, 'approved',
             c."submittedAt", c."submittedAt", ${input.importId}::uuid
      FROM jsonb_to_recordset(${jsonbParam(input.comments)}) AS c(
        id uuid, "pageId" uuid, "parentId" uuid, "authorName" text, content text,
        "submittedAt" timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        page_id = EXCLUDED.page_id, parent_id = EXCLUDED.parent_id,
        author_name = EXCLUDED.author_name, content = EXCLUDED.content,
        submitted_at = EXCLUDED.submitted_at, archived_at = EXCLUDED.archived_at
      WHERE comment_archive.data_import_id = EXCLUDED.data_import_id
      RETURNING 1
    `)) as unknown as unknown[];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { importId: input.importId, count: input.comments.length },
      succeeded: true,
      entityId: input.importId,
      resultSummary: `${rows.length} imported comments`,
    });
    return ok({ written: rows.length });
  },
});

/** Data imports — an undone import's comments, removed while no build carried them. */
export const commentArchiveRemoveImportOp = defineOperation({
  name: "comment_archive.remove_import",
  pluginAccess: "write",
  readScope: "request",
  // Why human-only: the comments plugin's import remove operation runs it
  // from undo_data_import; nobody deletes archive rows by import directly.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z.object({ importId: z.string().uuid() }).strict(),
  output: z.object({ removed: z.number().int() }),
  handler: async (ctx, input, tx) => {
    const op = "comment_archive.remove_import";
    const refusal = await ownImport(tx, ctx, input.importId, op, true);
    if (refusal) return err({ kind: "HandlerError", operation: op, message: refusal });
    const rows = (await tx.execute(sql`
      DELETE FROM comment_archive WHERE data_import_id = ${input.importId}::uuid RETURNING 1
    `)) as unknown as unknown[];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.importId,
      resultSummary: `${rows.length} imported comments removed`,
    });
    return ok({ removed: rows.length });
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
