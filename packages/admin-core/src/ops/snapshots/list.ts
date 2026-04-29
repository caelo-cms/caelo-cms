// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { ok, snapshotsListInput } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const snapshotRowSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  opKind: z.string(),
  description: z.string(),
  chatTaskId: z.string().nullable(),
  chatBranchId: z.string().nullable(),
  revertOf: z.string().nullable(),
  createdAt: z.string(),
  /** Counts so the timeline UI can show "12 changes" without a join roundtrip. */
  moduleCount: z.number().int().nonnegative(),
  templateCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  pageLayoutCount: z.number().int().nonnegative(),
});

/**
 * Reverse-chronological timeline. `since` lets the UI page backwards; the
 * default limit (50) keeps payloads sane on a long-running site.
 */
export const listSnapshotsOp = defineOperation({
  name: "snapshots.list",
  // CLAUDE.md §11: AI inspects history when planning ("what changed
  // on this page in the last 5 edits?"). Reads only — revert ops
  // remain human-only since they're a publish-boundary decision.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: snapshotsListInput,
  output: z.object({ snapshots: z.array(snapshotRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const beforeFilter = input.before ? sql`AND s.created_at < ${input.before}` : sql``;
    // Per-entity filter: include the snapshot if at least one entity-level
    // row in the matching table references the entity. Pages match either
    // page_snapshots or page_layout_snapshots — pages.update emits the first,
    // pages.set_modules emits the second.
    const moduleFilter = input.forModuleId
      ? sql`AND EXISTS (SELECT 1 FROM module_snapshots ms2 WHERE ms2.site_snapshot_id = s.id AND ms2.module_id = ${input.forModuleId}::uuid)`
      : sql``;
    const templateFilter = input.forTemplateId
      ? sql`AND EXISTS (SELECT 1 FROM template_snapshots ts2 WHERE ts2.site_snapshot_id = s.id AND ts2.template_id = ${input.forTemplateId}::uuid)`
      : sql``;
    const pageFilter = input.forPageId
      ? sql`AND (
          EXISTS (SELECT 1 FROM page_snapshots ps2 WHERE ps2.site_snapshot_id = s.id AND ps2.page_id = ${input.forPageId}::uuid)
          OR EXISTS (SELECT 1 FROM page_layout_snapshots pls2 WHERE pls2.site_snapshot_id = s.id AND pls2.page_id = ${input.forPageId}::uuid)
        )`
      : sql``;
    const opKindFilter =
      input.opKinds && input.opKinds.length > 0
        ? sql`AND s.op_kind IN (${sql.join(
            input.opKinds.map((k) => sql`${k}`),
            sql`, `,
          )})`
        : sql``;
    const archivedFilter = input.includeArchived ? sql`` : sql`AND s.archived_at IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT s.id::text AS id,
             s.actor_id::text AS actor_id,
             s.op_kind AS op_kind,
             s.description,
             s.chat_task_id::text AS chat_task_id,
             s.chat_branch_id::text AS chat_branch_id,
             s.revert_of::text AS revert_of,
             s.created_at,
             (SELECT count(*) FROM module_snapshots ms WHERE ms.site_snapshot_id = s.id)::int AS module_count,
             (SELECT count(*) FROM template_snapshots ts WHERE ts.site_snapshot_id = s.id)::int AS template_count,
             (SELECT count(*) FROM page_snapshots ps WHERE ps.site_snapshot_id = s.id)::int AS page_count,
             (SELECT count(*) FROM page_layout_snapshots pls WHERE pls.site_snapshot_id = s.id)::int AS page_layout_count
      FROM site_snapshots s
      WHERE 1=1 ${beforeFilter} ${moduleFilter} ${templateFilter} ${pageFilter} ${opKindFilter} ${archivedFilter}
      ORDER BY s.created_at DESC
      LIMIT ${input.limit}
    `)) as unknown as {
      id: string;
      actor_id: string;
      op_kind: string;
      description: string;
      chat_task_id: string | null;
      chat_branch_id: string | null;
      revert_of: string | null;
      created_at: string | Date;
      module_count: number;
      template_count: number;
      page_count: number;
      page_layout_count: number;
    }[];
    return ok({
      snapshots: rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        opKind: r.op_kind,
        description: r.description,
        chatTaskId: r.chat_task_id,
        chatBranchId: r.chat_branch_id,
        revertOf: r.revert_of,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        moduleCount: r.module_count,
        templateCount: r.template_count,
        pageCount: r.page_count,
        pageLayoutCount: r.page_layout_count,
      })),
    });
  },
});
