// SPDX-License-Identifier: MPL-2.0

/**
 * Atomic replace of `template_blocks` for one template. Uses DELETE-then-INSERT
 * inside the handler's transaction so a partial failure leaves zero rows
 * changed and the existing pages can keep referencing the previous slot set.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok, templateBlocksSetSchema } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitSnapshot, loadTemplateState } from "../../snapshots/index.js";

export const setTemplateBlocksOp = defineOperation({
  name: "template_blocks.set",
  // Why human-only: Owner-only — block schema is structural; AI changes module composition via pages.set_modules.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: templateBlocksSetSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const existing = (await tx.execute(sql`
      SELECT 1 FROM templates
      WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (existing.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "template_blocks.set",
        message: "template not found",
      });
    }

    // Reject duplicate block names within the payload — primary key would catch
    // it, but a typed error here is much friendlier to the UI.
    const seen = new Set<string>();
    for (const b of input.blocks) {
      if (seen.has(b.name)) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          operation: "template_blocks.set",
          input,
          succeeded: false,
          entityId: input.templateId,
          resultSummary: `duplicate-block-name=${b.name}`,
        });
        return err({
          kind: "HandlerError",
          operation: "template_blocks.set",
          message: `duplicate block name: ${b.name}`,
        });
      }
      seen.add(b.name);
    }

    await tx.execute(
      sql`DELETE FROM template_blocks WHERE template_id = ${input.templateId}::uuid`,
    );
    for (const b of input.blocks) {
      await tx.execute(sql`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${input.templateId}::uuid, ${b.name}, ${b.displayName}, ${b.position})
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "template_blocks.set",
      input,
      succeeded: true,
      entityId: input.templateId,
      resultSummary: `blocks=${input.blocks.length}`,
    });
    const state = await loadTemplateState(tx, input.templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "template_blocks.set",
        description: `template_blocks.set slug=${state.slug} blocks=${input.blocks.length}`,
        entities: [{ kind: "template", entityId: input.templateId, state }],
      });
    }
    return ok({});
  },
});
