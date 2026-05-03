// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, revertModuleInput } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  emitSnapshot,
  loadModuleState,
  parseAndUpgradeModuleState,
  parseSnapshotState,
  SnapshotSchemaError,
} from "../../snapshots/index.js";

/**
 * Restores one module's live row from a `module_snapshots` state JSONB.
 * Append-only history: the revert itself emits a new snapshot whose
 * revert_of points at the target snapshot.
 */
export const revertModuleOp = defineOperation({
  name: "snapshots.revert_module",
  // Why human-only: Owner-only — content revert; AI proposes via chat-keyed Undo path.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: revertModuleInput,
  output: z.object({ siteSnapshotId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT state FROM module_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
        AND module_id = ${input.moduleId}::uuid
      LIMIT 1
    `)) as unknown as { state: unknown }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.revert_module",
        message: "no module snapshot for that (snapshotId, moduleId) pair",
      });
    }
    let target: ReturnType<typeof parseAndUpgradeModuleState>;
    try {
      target = parseAndUpgradeModuleState(parseSnapshotState(row.state));
    } catch (e) {
      if (e instanceof SnapshotSchemaError) {
        return err({
          kind: "HandlerError",
          operation: "snapshots.revert_module",
          message: e.message,
        });
      }
      throw e;
    }

    // Update or restore the live row depending on whether deleted_at is set.
    await tx.execute(sql`
      UPDATE modules SET
        slug = ${target.slug},
        display_name = ${target.displayName},
        html = ${target.html},
        css = ${target.css},
        js = ${target.js},
        deleted_at = ${target.deletedAt},
        updated_at = now()
      WHERE id = ${input.moduleId}::uuid
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "snapshots.revert_module",
      input,
      succeeded: true,
      entityId: input.moduleId,
      resultSummary: `revert-of=${input.snapshotId.slice(0, 8)}`,
    });
    const newState = await loadModuleState(tx, input.moduleId);
    if (!newState) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.revert_module",
        message: "module disappeared mid-revert",
      });
    }
    const result = await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "snapshots.revert_module",
      description: `revert module → snapshot ${input.snapshotId.slice(0, 8)}`,
      revertOf: input.snapshotId,
      entities: [{ kind: "module", entityId: input.moduleId, state: newState }],
    });
    return ok({ siteSnapshotId: result.siteSnapshotId });
  },
});
