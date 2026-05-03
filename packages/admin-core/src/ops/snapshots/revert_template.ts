// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, revertTemplateInput } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  emitSnapshot,
  loadTemplateState,
  parseAndUpgradeTemplateState,
  parseSnapshotState,
  SnapshotSchemaError,
} from "../../snapshots/index.js";

/**
 * Restores a template's live row + its template_blocks rows from a
 * `template_snapshots` state JSONB. Atomic replace of the slot inventory
 * (DELETE-then-INSERT in the same tx) so the page composer never sees a
 * half-updated slot list.
 */
export const revertTemplateOp = defineOperation({
  name: "snapshots.revert_template",
  // Why human-only: Owner-only — template revert affects every bound page.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: revertTemplateInput,
  output: z.object({ siteSnapshotId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT state FROM template_snapshots
      WHERE site_snapshot_id = ${input.snapshotId}::uuid
        AND template_id = ${input.templateId}::uuid
      LIMIT 1
    `)) as unknown as { state: unknown }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.revert_template",
        message: "no template snapshot for that (snapshotId, templateId) pair",
      });
    }
    let target: ReturnType<typeof parseAndUpgradeTemplateState>;
    try {
      target = parseAndUpgradeTemplateState(parseSnapshotState(row.state));
    } catch (e) {
      if (e instanceof SnapshotSchemaError) {
        return err({
          kind: "HandlerError",
          operation: "snapshots.revert_template",
          message: e.message,
        });
      }
      throw e;
    }

    await tx.execute(sql`
      UPDATE templates SET
        slug = ${target.slug},
        display_name = ${target.displayName},
        html = ${target.html},
        css = ${target.css},
        deleted_at = ${target.deletedAt},
        updated_at = now()
      WHERE id = ${input.templateId}::uuid
    `);

    // Atomic replace of slot inventory.
    await tx.execute(sql`
      DELETE FROM template_blocks WHERE template_id = ${input.templateId}::uuid
    `);
    for (const b of target.blocks) {
      await tx.execute(sql`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${input.templateId}::uuid, ${b.name}, ${b.displayName}, ${b.position})
      `);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "snapshots.revert_template",
      input,
      succeeded: true,
      entityId: input.templateId,
      resultSummary: `revert-of=${input.snapshotId.slice(0, 8)}`,
    });
    const newState = await loadTemplateState(tx, input.templateId);
    if (!newState) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.revert_template",
        message: "template disappeared mid-revert",
      });
    }
    const result = await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "snapshots.revert_template",
      description: `revert template → snapshot ${input.snapshotId.slice(0, 8)}`,
      revertOf: input.snapshotId,
      entities: [{ kind: "template", entityId: input.templateId, state: newState }],
    });
    return ok({ siteSnapshotId: result.siteSnapshotId });
  },
});
