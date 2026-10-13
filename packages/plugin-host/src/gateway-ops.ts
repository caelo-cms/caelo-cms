// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/gateway-ops — the core Query API operations the
 * public API gateway runs (issue #634).
 *
 * The gateway's OperationRegistry is its allowlist into cms_admin: it holds
 * exactly the operations a visitor-facing path needs, nothing else. Each
 * one runs as `gateway_role`, whose grants (migrations 0248 + 0252) cover
 * precisely the columns and rows these handlers touch — the registry and
 * the database agree on the surface, and the database is the bound:
 *
 *   comment_archive.list_for_page  the comments plugin's `list_approved`
 *                                  (via `ctx.cms.call`) — approved comments
 *                                  only, enforced by a gateway_role policy
 *
 * They live here, not in admin-core, because the gateway must not import
 * admin-core (it would pull the whole authoring stack into the public
 * image); the admin registers the same definitions, so the two processes
 * can never drift on an operation's shape.
 */

import { defineOperation, type OperationRegistry } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const listForPageInput = z
  .object({
    pageId: z.string().uuid(),
    status: z.enum(["approved", "rejected", "spam"]).optional(),
    since: z.string().datetime().optional(),
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
 * Read archived comments for one page (approved by default). The static
 * bake and the comments plugin's visitor `list_approved` both read here
 * (v0.2.18 Fix D: cms_public only holds the pending inbox). In the gateway
 * a `gateway_role` policy limits the rows to approved ones whatever
 * `status` the caller passes.
 */
export const commentArchiveListForPageOp = defineOperation({
  name: "comment_archive.list_for_page",
  actorScope: ["human", "ai", "system", "plugin"],
  database: "cms_admin",
  input: listForPageInput,
  output: z.object({ comments: z.array(archiveRowSchema) }),
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
        archived_at
      FROM comment_archive
      WHERE page_id = ${input.pageId}::uuid
        AND status = ${status}
        AND archived_at > ${since}::timestamptz
      ORDER BY submitted_at ASC
      LIMIT ${limit}
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
    }>;
    return ok({
      comments: rows.map((r) => ({
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
 * Register the gateway's whole core-operation surface on its registry.
 * Nothing else belongs there: an operation missing here answers
 * `UnknownOperation` to the gateway's plugins, and one added here needs a
 * matching `gateway_role` grant (migrations 0252, 0259).
 */
export function registerGatewayOperations(registry: OperationRegistry): void {
  registry.register(commentArchiveListForPageOp);
}
