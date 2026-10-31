// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1062 — `content_instances.list_module_peers`: the content
 * instances of the module(s) a write touched, and nothing else.
 *
 * The repeated-value hint after a content write compares the written
 * values with the other instances of the SAME module. Reading the whole
 * content library for that would cost one full scan per write — at the
 * 50k-page scale of epic #1003 that is the dominant cost of a build. This
 * op resolves the write's targets (module ids, instance ids, placements)
 * to their modules and reads only those modules' instances, as the
 * caller's branch sees them.
 */

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  loadContentInstanceBranchStates,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { countPlacementsInView } from "./content-instance-reach.js";

const MAX_TARGETS = 200;

/** Input of `content_instances.list_module_peers`. */
export const listModulePeersInput = z
  .object({
    moduleIds: z.array(z.string().uuid()).max(MAX_TARGETS).default([]),
    contentInstanceIds: z.array(z.string().uuid()).max(MAX_TARGETS).default([]),
    placements: z
      .array(
        z
          .object({
            pageId: z.string().uuid(),
            blockName: z.string().min(1).max(80),
            position: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(MAX_TARGETS)
      .default([]),
  })
  .strict();

const peerSchema = z.object({
  id: z.string(),
  moduleId: z.string(),
  moduleDisplayName: z.string(),
  placementCount: z.number().int().nonnegative(),
  values: z.record(z.string(), z.unknown()),
});

export const listModulePeersOp = defineOperation({
  name: "content_instances.list_module_peers",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: listModulePeersInput,
  output: z.object({ instances: z.array(peerSchema) }),
  handler: async (ctx, input, tx) => {
    const branchId = ctx.chatBranchId ?? null;
    const visible = branchId
      ? sql`(ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${branchId}::uuid)`
      : sql`ci.chat_branch_id IS NULL`;
    const moduleIds = new Set(input.moduleIds);
    if (input.contentInstanceIds.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT DISTINCT ci.module_id::text AS module_id FROM content_instances ci
        WHERE ci.id = ANY(${uuidArray(input.contentInstanceIds)}) AND ${visible}
      `)) as unknown as { module_id: string }[];
      for (const r of rows) moduleIds.add(r.module_id);
    }
    for (const pageId of new Set(input.placements.map((p) => p.pageId))) {
      const layout = await loadPageLayoutStateWithBranchOverlay(tx, pageId, branchId);
      for (const p of input.placements.filter((x) => x.pageId === pageId)) {
        const placed = layout.blocks.find((b) => b.blockName === p.blockName)?.placements?.[
          p.position
        ];
        if (placed) moduleIds.add(placed.moduleId);
      }
    }
    if (moduleIds.size === 0) return ok({ instances: [] });

    const rows = (await tx.execute(sql`
      SELECT ci.id::text AS id, ci.module_id::text AS module_id,
             m.display_name AS module_display_name, ci."values" AS values
      FROM content_instances ci
      JOIN modules m ON m.id = ci.module_id
      WHERE ci.module_id = ANY(${uuidArray([...moduleIds])}) AND ci.deleted_at IS NULL AND ${visible}
    `)) as unknown as {
      id: string;
      module_id: string;
      module_display_name: string;
      values: unknown;
    }[];
    const ids = rows.map((r) => r.id);
    const states = branchId
      ? await loadContentInstanceBranchStates(tx, ids, branchId)
      : new Map<string, never>();
    const live = rows.filter((r) => !states.get(r.id)?.deletedAt);
    const counts = await countPlacementsInView(
      tx,
      live.map((r) => r.id),
      branchId,
    );
    return ok({
      instances: live.map((r) => {
        const raw = r.values;
        return {
          id: r.id,
          moduleId: r.module_id,
          moduleDisplayName: r.module_display_name,
          placementCount: counts.get(r.id) ?? 0,
          values: states.get(r.id)?.values ?? ((raw ?? {}) as Record<string, unknown>),
        };
      }),
    });
  },
});
