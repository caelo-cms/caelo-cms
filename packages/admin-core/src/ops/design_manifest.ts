// SPDX-License-Identifier: MPL-2.0

/**
 * issue #165 — Design Manifest ops. Routine scope (`human + ai +
 * system`): the manifest is decision-support metadata, one call
 * reverts it, and the AI writes it as the final materialisation step
 * of the operator-approved Genesis flow.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { type DesignManifest, designManifestSchema, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";

export const getDesignManifestOp = defineOperation({
  name: "design_manifest.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ manifest: designManifestSchema.nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT payload FROM design_manifests WHERE id = 1 LIMIT 1`,
    )) as unknown as { payload: unknown }[];
    const raw = rows[0]?.payload;
    if (raw === undefined || raw === null) return ok({ manifest: null });
    const parsed = designManifestSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    // Malformed stored payloads read as null; the write path validates,
    // so this only fires on manual DB surgery.
    return ok({ manifest: parsed.success ? (parsed.data as DesignManifest) : null });
  },
});

export const setDesignManifestOp = defineOperation({
  name: "design_manifest.set",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ manifest: designManifestSchema }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const keys = Object.keys(input.manifest);
    if (keys.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "design_manifest.set",
        message:
          "manifest is empty — pass at least one of tokenRoles / typography / rhythm / patterns / imagery / avoid",
      });
    }
    await tx.execute(sql`
      INSERT INTO design_manifests (id, payload, updated_at, updated_by)
      VALUES (1, ${jsonbParam(input.manifest)}, now(), ${ctx.actorId}::uuid)
      ON CONFLICT (id) DO UPDATE
      SET payload = EXCLUDED.payload, updated_at = now(), updated_by = EXCLUDED.updated_by
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "design_manifest.set",
      input: { sections: keys },
      succeeded: true,
      resultSummary: `manifest sections: ${keys.join(", ")}`,
    });
    return ok({});
  },
});
