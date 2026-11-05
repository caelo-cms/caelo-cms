// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1387 — `plugins.get_draft_rows`: the current draft state of plugin
 * rows that have a pending change on the caller's branch.
 *
 * This is the read a draft conflict on a plugin row names (`locks.ts`), and
 * the only read that clears one (the `get_plugin_draft_rows` tool records it
 * through `chat.observe_draft_reads`). It belongs to the host, not to each
 * plugin: a plugin's own reads run through `plugin_storage.list`, which chat
 * preview renders and write tools use too, so a read there cannot mean "the
 * AI has seen it". And a read every plugin had to declare would leave every
 * table without such a declaration, and every artifact approved before it,
 * with a conflict nothing clears.
 *
 * Scoped to what a conflict can be about: rows with a pending change on the
 * caller's branch, of a plugin running on this instance. A row outside that
 * is reported as having no pending change.
 *
 * Values are shown only for a table the plugin lists in `aiReadableTables`,
 * reviewed by the Owner in its manifest, and only the columns it declares
 * today (what its own reads return, `privateReadColumns`). Private rows can
 * hold what the AI must not read (newsletter's `send_runs` carries recipient
 * addresses and unsubscribe tokens), so an unlisted table, which includes
 * every artifact approved before the list existed, shows who changed which
 * row and when, never its values. That read still clears the conflict:
 * otherwise such a row would conflict forever, and the AI has at that point
 * been told exactly what it is writing over.
 *
 * Nothing here reaches a plugin: no handle, no credential, no write.
 */

import { loadedPlugins } from "@caelo-cms/plugin-host";
import { privateReadColumns } from "@caelo-cms/plugin-sandbox";
import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { err, getPluginDraftRowsToolInput, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const draftRow = z.object({
  id: z.string().uuid(),
  plugin: z.string(),
  table: z.string(),
  /** The pending change deletes the row. */
  deleted: z.boolean(),
  /** Null when the plugin keeps this table from the AI (`aiReadableTables`). */
  values: z.record(z.string(), z.unknown()).nullable(),
  changedAt: z.string(),
  changedByChat: z.string(),
});

interface HeadRow {
  id: string;
  plugin_id: string;
  table_name: string;
  state: {
    values: Record<string, unknown>;
    deletedAt: string | null;
  };
  changed_at: string;
  chat_title: string | null;
}

/** The row's values reduced to what the plugin's own reads return. */
function declaredValues(
  columns: Readonly<Record<string, string>>,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const readable = new Set(privateReadColumns(columns));
  return Object.fromEntries(Object.entries(values).filter(([k]) => readable.has(k)));
}

export const getDraftRowsOp = defineOperation({
  name: "plugins.get_draft_rows",
  readScope: "request",
  // Default scope (CLAUDE.md §11); a plugin actor has its own reads.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: getPluginDraftRowsToolInput,
  output: z.object({ rows: z.array(draftRow), noPendingChange: z.array(z.string().uuid()) }),
  handler: async (ctx, input, tx) => {
    const operation = "plugins.get_draft_rows";
    if (!ctx.chatBranchId) {
      return err({
        kind: "HandlerError" as const,
        operation,
        message: `${operation}: a pending plugin change lives on a chat's branch, so this read only works inside a chat`,
      });
    }
    const rowIds = [...new Set(input.rowIds)];
    // One head row per pending row and owner; the newest across owners is
    // the row's draft state (the order of every overlay, migration 0477).
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (d.entity_id)
             d.entity_id::text AS id, d.plugin_id::text AS plugin_id, d.table_name, prs.state,
             to_char(d.header_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS changed_at,
             cs.title AS chat_title
      FROM draft_pending_entities d
      JOIN plugin_row_snapshots prs ON prs.id = d.snapshot_row_id
      LEFT JOIN chat_sessions cs ON cs.id = d.owner_chat_session_id
      WHERE d.chat_branch_id = ${ctx.chatBranchId}::uuid
        AND d.entity_kind = 'pluginRow'
        AND d.entity_id = ANY(${uuidArray(rowIds)})
      ORDER BY d.entity_id, d.header_created_at DESC, d.row_created_at DESC, d.snapshot_row_id DESC
    `)) as unknown as HeadRow[];
    const shown = rows.flatMap((r) => {
      const plugin = loadedPlugins.byId(r.plugin_id);
      const columns = plugin?.definition.adminSchema?.[r.table_name];
      if (!plugin || !columns) return [];
      return [
        {
          id: r.id,
          plugin: plugin.slug,
          table: r.table_name,
          deleted: r.state.deletedAt !== null,
          values: plugin.definition.aiReadableTables?.includes(r.table_name)
            ? declaredValues(columns, r.state.values)
            : null,
          changedAt: r.changed_at,
          changedByChat: r.chat_title ?? "a change made outside a chat",
        },
      ];
    });
    const shownIds = new Set(shown.map((r) => r.id));
    return ok({ rows: shown, noPendingChange: rowIds.filter((id) => !shownIds.has(id)) });
  },
});
