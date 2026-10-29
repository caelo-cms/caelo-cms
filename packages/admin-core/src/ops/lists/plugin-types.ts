// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G — `list_types.sync_plugin_types`: store the list types
 * a plugin ships (manifest `listTypes`) as list types the plugin owns.
 *
 * The plugin host calls it each time the plugin loads (boot, Owner
 * activation), with the definitions from the VERIFIED manifest, so a
 * stored type always equals what the running artifact declares. A changed
 * definition goes through `list_types.upsert_many`'s own handler — checked
 * against every list of the type, snapshotted, audited, emitting
 * `list_type.changed` — exactly like an operator's change; an unchanged
 * one writes nothing. Ownership (`list_types.plugin_id`, migration 0357)
 * makes the type available only while the plugin runs and refuses edits
 * by people and the AI (list-types.ts).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { listTypeDefSchema, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { handlerError } from "./_shared.js";
import { upsertListTypesManyOp } from "./list-types.js";

export const syncPluginListTypesOp = defineOperation({
  name: "list_types.sync_plugin_types",
  // Why system-only: the host writes these from a plugin's verified
  // manifest when the plugin loads. A plugin cannot write list types
  // (structure writes refuse the plugin actor), and the AI shapes types
  // with list_types.upsert_many.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      pluginId: z.string().uuid(),
      listTypes: z.array(listTypeDefSchema).min(1).max(20),
    })
    .strict(),
  output: z.object({
    synced: z.array(z.object({ slug: z.string(), changed: z.boolean() })),
  }),
  handler: async (ctx, input, tx) => {
    const op = "list_types.sync_plugin_types";
    const synced: { slug: string; changed: boolean }[] = [];
    // Main line only: a plugin's types describe the running artifact,
    // not any chat's draft.
    const mainCtx = { ...ctx, chatBranchId: undefined, chatTaskId: undefined };
    for (const def of input.listTypes) {
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, plugin_id::text AS plugin_id, definition
        FROM list_types
        WHERE slug = ${def.slug} AND chat_branch_id IS NULL AND deleted_at IS NULL
      `)) as unknown as { id: string; plugin_id: string | null; definition: unknown }[];
      const row = rows[0];
      if (row && row.plugin_id !== input.pluginId) {
        return {
          ok: false,
          error: handlerError(
            op,
            `list type "${def.slug}" already exists and does not belong to this plugin — rename or delete that type (list_types.delete_many), then activate the plugin again.`,
            true,
          ),
        };
      }
      const stored = row === undefined ? null : row.definition;
      if (stored !== null && JSON.stringify(stored) === JSON.stringify(def)) {
        synced.push({ slug: def.slug, changed: false });
        continue;
      }
      const r = await upsertListTypesManyOp.handler(
        mainCtx,
        { listTypes: [def], dropValues: false },
        tx,
      );
      if (!r.ok) return r;
      const id = r.value.listTypes[0]?.id;
      if (!id) throw new Error(`${op}: upsert of ${def.slug} returned no id`);
      await tx.execute(sql`
        UPDATE list_types SET plugin_id = ${input.pluginId}::uuid
        WHERE id = ${id}::uuid AND chat_branch_id IS NULL
      `);
      synced.push({ slug: def.slug, changed: true });
    }
    return ok({ synced });
  },
});
