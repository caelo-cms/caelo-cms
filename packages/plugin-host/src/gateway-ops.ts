// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/gateway-ops — the core Query API operations the
 * public API gateway runs (issue #634).
 *
 * The gateway's OperationRegistry holds exactly the core operations a
 * visitor-facing path needs, nothing else. Since #635 every one of them
 * reads the projection the admin publishes into cms_public — the gateway
 * has no cms_admin login:
 *
 *   comment_archive.list_for_page  the comments plugin's `list_approved`
 *                                  (via `ctx.cms.call`), served from
 *                                  `published_comments` (approved only)
 *
 * They live here, not in admin-core, because the gateway must not import
 * admin-core (it would pull the whole authoring stack into the public
 * image). The admin registers the cms_admin twin of each operation
 * (`commentArchiveListForPageOp`); both share one input and output schema
 * declared below, so the two processes cannot drift on an operation's
 * shape.
 */

import { defineOperation, type OperationRegistry } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Keyset position in a page's thread (#1169). `archivedAt` keeps Postgres'
 * microseconds: a `Date` would round them to milliseconds, and a page break
 * inside that millisecond would skip or repeat comments.
 */
const threadCursor = z
  .object({ archivedAt: z.string().datetime({ precision: 6 }), id: z.string().uuid() })
  .strict();

const listForPageInput = z
  .object({
    pageId: z.string().uuid(),
    status: z.enum(["approved", "rejected", "spam"]).optional(),
    /** Only comments archived after this instant: the bake's delta feed. */
    since: z.string().datetime().optional(),
    /** Only comments older than this position: the next page of the thread. */
    before: threadCursor.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const archiveRowSchema = z.object({
  id: z.string(),
  publicRowId: z.string(),
  pageId: z.string(),
  parentId: z.string().nullable(),
  authorName: z.string(),
  content: z.string(),
  status: z.string(),
  submittedAt: z.string(),
  archivedAt: z.string(),
});

/**
 * A page of a thread, newest approval first. `archived_at` is the one axis
 * of both feeds (#1169): the bake is the top of it, `since` reads above the
 * bake and `before` below it, so nothing can fall between them, and both
 * tables already index it per page.
 */
const listForPageOutput = z.object({
  comments: z.array(archiveRowSchema),
  /** Pass as `before` for the next page; null on the last page. */
  nextCursor: threadCursor.nullable(),
});

/**
 * Where a page starts in the thread (`before` of the input), as SQL. The
 * reads select `id::text AS id`, so their ORDER BY names the table's column
 * to sort by the same uuid this compares.
 */
function beforeClause(before: z.infer<typeof threadCursor> | undefined) {
  return before
    ? sql`AND (archived_at, id) < (${before.archivedAt}::timestamptz, ${before.id}::uuid)`
    : sql``;
}

/** The exact position of a row: `threadCursor.archivedAt` with its microseconds. */
const CURSOR_COLUMN = sql`to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;

/** Split the `limit + 1` rows a page reads into the page and its next cursor. */
function pageOf<R extends { id: string; cursor_at: string }>(
  rows: readonly R[],
  limit: number,
): { page: readonly R[]; nextCursor: z.infer<typeof threadCursor> | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: rows.length > limit && last ? { archivedAt: last.cursor_at, id: last.id } : null,
  };
}

/**
 * Read archived comments for one page (approved by default). The static
 * bake and the comments plugin's visitor `list_approved` both read here
 * (v0.2.18 Fix D: cms_public only holds the pending inbox). The ADMIN's
 * implementation; the gateway serves the same contract from the published
 * projection ({@link publishedCommentsListForPageOp}).
 */
export const commentArchiveListForPageOp = defineOperation({
  name: "comment_archive.list_for_page",
  readScope: "request",
  actorScope: ["human", "ai", "system", "plugin"],
  database: "cms_admin",
  input: listForPageInput,
  output: listForPageOutput,
  handler: async (_ctx, input, tx) => {
    const status = input.status ?? "approved";
    const limit = input.limit ?? 200;
    const since = input.since ?? "1970-01-01T00:00:00Z";
    const rows = (await tx.execute(sql`
      SELECT
        id::text             AS id,
        public_row_id::text  AS public_row_id,
        page_id::text        AS page_id,
        parent_id::text      AS parent_id,
        author_name,
        content,
        status,
        submitted_at,
        archived_at,
        ${CURSOR_COLUMN}
      FROM comment_archive
      WHERE page_id = ${input.pageId}::uuid
        AND status = ${status}
        AND archived_at > ${since}::timestamptz
        ${beforeClause(input.before)}
      ORDER BY archived_at DESC, comment_archive.id DESC
      LIMIT ${limit + 1}
    `)) as unknown as Array<{
      id: string;
      public_row_id: string;
      page_id: string;
      parent_id: string | null;
      author_name: string;
      content: string;
      status: string;
      submitted_at: string | Date;
      archived_at: string | Date;
      cursor_at: string;
    }>;
    const { page, nextCursor } = pageOf(rows, limit);
    return ok({
      nextCursor,
      comments: page.map((r) => ({
        id: r.id,
        publicRowId: r.public_row_id,
        pageId: r.page_id,
        parentId: r.parent_id,
        authorName: r.author_name,
        content: r.content,
        status: r.status,
        submittedAt: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at,
        archivedAt: r.archived_at instanceof Date ? r.archived_at.toISOString() : r.archived_at,
      })),
    });
  },
});

/**
 * The gateway's implementation of `comment_archive.list_for_page` (#635):
 * the same contract (input, output, approved-only), served from the
 * APPROVED comments the admin publishes into cms_public — the gateway has
 * no cms_admin login. Whatever `status` a caller asks for, only approved
 * comments exist on the public side.
 */
export const publishedCommentsListForPageOp = defineOperation({
  name: "comment_archive.list_for_page",
  readScope: "request",
  actorScope: ["system", "plugin"],
  database: "cms_public",
  input: listForPageInput,
  output: listForPageOutput,
  handler: async (_ctx, input, tx) => {
    if ((input.status ?? "approved") !== "approved") return ok({ comments: [], nextCursor: null });
    const limit = input.limit ?? 200;
    const since = input.since ?? "1970-01-01T00:00:00Z";
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, public_row_id::text AS public_row_id, page_id::text AS page_id,
             parent_id::text AS parent_id, author_name, content, submitted_at, archived_at,
             ${CURSOR_COLUMN}
      FROM published_comments
      WHERE page_id = ${input.pageId}::uuid AND archived_at > ${since}::timestamptz
        ${beforeClause(input.before)}
      ORDER BY archived_at DESC, published_comments.id DESC
      LIMIT ${limit + 1}
    `)) as unknown as Array<{
      id: string;
      public_row_id: string;
      page_id: string;
      parent_id: string | null;
      author_name: string;
      content: string;
      submitted_at: string | Date;
      archived_at: string | Date;
      cursor_at: string;
    }>;
    const { page, nextCursor } = pageOf(rows, limit);
    return ok({
      nextCursor,
      comments: page.map((r) => ({
        id: r.id,
        publicRowId: r.public_row_id,
        pageId: r.page_id,
        parentId: r.parent_id,
        authorName: r.author_name,
        content: r.content,
        status: "approved",
        submittedAt: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at,
        archivedAt: r.archived_at instanceof Date ? r.archived_at.toISOString() : r.archived_at,
      })),
    });
  },
});

/**
 * Register the gateway's whole core-operation surface on its registry.
 * Nothing else belongs there: an operation missing here answers
 * `UnknownOperation` to the gateway's plugins. Every one runs on
 * cms_public — the gateway has no cms_admin login (#635), and
 * `gateway-boundary.test.ts` fails CI if one here names cms_admin.
 */
export function registerGatewayOperations(registry: OperationRegistry): void {
  registry.register(publishedCommentsListForPageOp);
}
