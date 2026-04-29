// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo/query-api";
import { err, ok, snapshotGetInput } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { parseSnapshotState } from "../../snapshots/index.js";

const entityRowSchema = z.object({
  entityId: z.string(),
  state: z.unknown(),
});

/**
 * Returns one site snapshot expanded to its entity-level rows. The Advanced
 * History drawer renders this view when the user clicks into a timeline
 * entry.
 */
export const getSnapshotWithEntitiesOp = defineOperation({
  name: "snapshots.get_with_entities",
  // CLAUDE.md §11: AI inspects snapshot detail when planning a revert
  // suggestion or summarising history.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: snapshotGetInput,
  output: z.object({
    snapshot: z.object({
      id: z.string(),
      actorId: z.string(),
      description: z.string(),
      chatTaskId: z.string().nullable(),
      revertOf: z.string().nullable(),
      createdAt: z.string(),
    }),
    modules: z.array(entityRowSchema),
    templates: z.array(entityRowSchema),
    pages: z.array(entityRowSchema),
    pageLayouts: z.array(entityRowSchema),
  }),
  handler: async (_ctx, input, tx) => {
    const snapRows = (await tx.execute(sql`
      SELECT id::text AS id, actor_id::text AS actor_id, description,
             chat_task_id::text AS chat_task_id, revert_of::text AS revert_of, created_at
      FROM site_snapshots WHERE id = ${input.snapshotId}::uuid LIMIT 1
    `)) as unknown as {
      id: string;
      actor_id: string;
      description: string;
      chat_task_id: string | null;
      revert_of: string | null;
      created_at: string | Date;
    }[];
    const snap = snapRows[0];
    if (!snap) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.get_with_entities",
        message: "snapshot not found",
      });
    }

    type Row = { entity_id: string; state: unknown };
    const ms = (await tx.execute(sql`
      SELECT module_id::text AS entity_id, state FROM module_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];
    const ts = (await tx.execute(sql`
      SELECT template_id::text AS entity_id, state FROM template_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];
    const ps = (await tx.execute(sql`
      SELECT page_id::text AS entity_id, state FROM page_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];
    const pls = (await tx.execute(sql`
      SELECT page_id::text AS entity_id, state FROM page_layout_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
    `)) as unknown as Row[];

    return ok({
      snapshot: {
        id: snap.id,
        actorId: snap.actor_id,
        description: snap.description,
        chatTaskId: snap.chat_task_id,
        revertOf: snap.revert_of,
        createdAt:
          snap.created_at instanceof Date ? snap.created_at.toISOString() : String(snap.created_at),
      },
      modules: ms.map((r) => ({ entityId: r.entity_id, state: parseSnapshotState(r.state) })),
      templates: ts.map((r) => ({ entityId: r.entity_id, state: parseSnapshotState(r.state) })),
      pages: ps.map((r) => ({ entityId: r.entity_id, state: parseSnapshotState(r.state) })),
      pageLayouts: pls.map((r) => ({ entityId: r.entity_id, state: parseSnapshotState(r.state) })),
    });
  },
});
