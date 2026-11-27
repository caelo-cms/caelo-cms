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
 * caller's branch, of a plugin running on this instance. A pending row this
 * read cannot show (plugin disabled or not loaded, table no longer declared)
 * is listed as `unavailable`: it is not recorded as seen, so its conflict
 * stands, and it never reads as "nothing pending".
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

import { isPluginDisabled, loadedPlugins } from "@caelo-cms/plugin-host";
import { privateReadColumns } from "@caelo-cms/plugin-sandbox";
import { defineOperation, textArray, uuidArray } from "@caelo-cms/query-api";
import { err, getPluginDraftRowsToolInput, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { isSystemActorSql } from "../../locks.js";

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
  output: z.object({
    rows: z.array(draftRow),
    noPendingChange: z.array(z.string().uuid()),
    /** Pending, but this read cannot show it: not recorded as seen. */
    unavailable: z.array(z.string().uuid()),
  }),
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
    // `entity_sub` is plugin/table: two tables may hold the same row id.
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (d.entity_id, d.entity_sub)
             d.entity_id::text AS id, d.plugin_id::text AS plugin_id, d.table_name, prs.state,
             to_char(d.header_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS changed_at,
             cs.title AS chat_title
      FROM draft_pending_entities d
      JOIN plugin_row_snapshots prs ON prs.id = d.snapshot_row_id
      LEFT JOIN chat_sessions cs ON cs.id = d.owner_chat_session_id
      WHERE d.chat_branch_id = ${ctx.chatBranchId}::uuid
        AND d.entity_kind = 'pluginRow'
        AND d.entity_id = ANY(${uuidArray(rowIds)})
      ORDER BY d.entity_id, d.entity_sub, d.header_created_at DESC, d.row_created_at DESC, d.snapshot_row_id DESC
    `)) as unknown as HeadRow[];
    const unavailable = new Set<string>();
    const shown = rows.flatMap((r) => {
      const plugin = loadedPlugins.byId(r.plugin_id);
      const columns = plugin?.definition.adminSchema?.[r.table_name];
      if (!plugin || !columns || isPluginDisabled(plugin.slug)) {
        unavailable.add(r.id);
        return [];
      }
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
    const pending = new Set(rows.map((r) => r.id));
    return ok({
      rows: shown,
      noPendingChange: rowIds.filter((id) => !pending.has(id)),
      unavailable: [...unavailable],
    });
  },
});

/** Most rows one read names: what a refusal lists, enough to re-read them all. */
const UNSEEN_ROWS_MAX = 100;

const unseenRow = z.object({
  id: z.string().uuid(),
  table: z.string(),
  changedAt: z.string(),
  changedByChat: z.string(),
});

/**
 * Issue #1705 — `plugins.unseen_draft_rows`: the rows of a plugin that
 * another chat changed in the shared draft after the calling chat last saw
 * them, and that are about the given entities (the row's id, or an id among
 * its values: consent-manager's verdict row names its module in
 * `module_id`). What a write of them would refuse as a draft conflict
 * (`locks.ts`).
 *
 * Asked before an approval card of a draft-bound plugin tool is shown
 * (`ai/plugin-approval-staleness.ts`) with the ids the call names, so the
 * Owner is not asked to approve a call that would then refuse to apply. A
 * row the call writes that names none of them is still checked when the
 * approved call writes it. It names exactly the changes that check counts:
 * every other chat's and every change without a chat, except the plugin's
 * own change-journal batch re-deriving the row (system actor, no chat
 * task; `isSystemActorSql`), which the conflict check never counts.
 *
 * Empty outside a draft chat (no draft to be stale against).
 */
export const unseenDraftRowsOp = defineOperation({
  name: "plugins.unseen_draft_rows",
  readScope: "request",
  // Default scope (CLAUDE.md §11): a read of the caller's own chat's view.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pluginSlug: z.string().min(1).max(55),
      /** The entities the call is about: ids among its arguments. */
      entityIds: z.array(z.string().uuid()).min(1).max(50),
    })
    .strict(),
  output: z.object({ rows: z.array(unseenRow) }),
  handler: async (ctx, input, tx) => {
    const plugin = loadedPlugins.bySlug(input.pluginSlug);
    if (!plugin) {
      return err({
        kind: "HandlerError" as const,
        operation: "plugins.unseen_draft_rows",
        message: `plugins.unseen_draft_rows: no plugin "${input.pluginSlug}" runs on this server (list_plugins shows the installed ones)`,
      });
    }
    if (!ctx.chatBranchId || !ctx.chatTaskId) return ok({ rows: [] });
    const ids = [...new Set(input.entityIds)];
    // One head row per pending row and owner (migration 0477): every other
    // chat's newest change of each of the plugin's rows, newer than this
    // chat's observation of it. The partial plugin index drives the scan;
    // the snapshot holds the row's state as that chat left it.
    const rows = (await tx.execute(sql`
      WITH me AS (
        SELECT caelo_chat_owner(cs.id) AS owner
        FROM chat_sessions cs
        WHERE cs.id = ${ctx.chatTaskId}::uuid AND cs.chat_branch_id = ${ctx.chatBranchId}::uuid
          AND cs.branch_kind = 'draft'
      )
      SELECT DISTINCT ON (d.entity_id, d.entity_sub)
             d.entity_id::text AS id, d.table_name,
             to_char(d.header_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS changed_at,
             cs.title AS chat_title, d.owner_chat_session_id IS NULL AS outside_chat
      FROM me
      JOIN draft_pending_entities d
        ON d.chat_branch_id = ${ctx.chatBranchId}::uuid
       AND d.entity_kind = 'pluginRow'
       AND d.plugin_id = ${plugin.pluginId}::uuid
      JOIN plugin_row_snapshots prs ON prs.id = d.snapshot_row_id
      JOIN site_snapshots ss ON ss.id = d.site_snapshot_id
      LEFT JOIN chat_sessions cs ON cs.id = d.owner_chat_session_id
      LEFT JOIN draft_entity_observations o
        ON o.chat_session_id = me.owner AND o.entity_kind = 'pluginRow' AND o.entity_id = d.entity_id
      WHERE d.owner_chat_session_id IS DISTINCT FROM me.owner
        AND NOT (d.owner_chat_session_id IS NULL AND ${isSystemActorSql(sql`ss.actor_id`)})
        AND d.header_created_at > COALESCE(o.seen_at, '-infinity'::timestamptz)
        AND (
          d.entity_id = ANY(${uuidArray(ids)})
          OR EXISTS (
            SELECT 1 FROM jsonb_each(prs.state->'values') v
            WHERE jsonb_typeof(v.value) = 'string' AND v.value #>> '{}' = ANY(${textArray(ids)})
          )
        )
      ORDER BY d.entity_id, d.entity_sub, d.header_created_at DESC
      LIMIT ${UNSEEN_ROWS_MAX}
    `)) as unknown as {
      id: string;
      table_name: string;
      changed_at: string;
      chat_title: string | null;
      outside_chat: boolean;
    }[];
    return ok({
      rows: rows.map((r) => ({
        id: r.id,
        table: r.table_name,
        changedAt: r.changed_at,
        // The conflict message's words for the same change (locks.ts).
        changedByChat: r.outside_chat
          ? "a change made outside a chat"
          : (r.chat_title ?? "a chat that was deleted since"),
      })),
    });
  },
});
