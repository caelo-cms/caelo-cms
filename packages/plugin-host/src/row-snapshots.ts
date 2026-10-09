// SPDX-License-Identifier: MPL-2.0

/**
 * Snapshots and branch overlay for plugin private-zone rows
 * (docs/branch-aware-plugin-storage.md, CMS_REQUIREMENTS §14.7).
 *
 * The pattern is the one core content already uses for content
 * instances: a write on a chat branch records the row's full new state
 * in `plugin_row_snapshots`, tagged with the branch through its
 * `site_snapshots` header, and leaves the live row alone; a read on that
 * branch overlays the latest branch state onto the live row. Publishing
 * the branch applies the latest state to the live row
 * ({@link applyPluginRowState}); discarding it drops the rows the branch
 * created ({@link discardBranchPluginRows}).
 *
 * A row created on a branch is inserted into the live table right away,
 * tagged with `caelo_chat_branch_id`, so its id is stable and core
 * foreign keys resolve; main-line reads skip tagged rows until the merge
 * clears the tag.
 *
 * The header insert mirrors admin-core's `emitSnapshot`. It lives here
 * because the plugin host cannot import admin-core (admin-core depends
 * on the plugin host), and the storage operations must snapshot inside
 * their own transaction.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** A plugin row's state as snapshotted. `values` holds every non-host column. */
export interface PluginRowState {
  readonly schemaVersion: 1;
  readonly values: Readonly<Record<string, unknown>>;
  readonly deletedAt: string | null;
  readonly version: number;
}

export type PluginRowOpKind =
  | "plugin_storage.insert"
  | "plugin_storage.update"
  | "plugin_storage.delete";

/** Where a row lives: the owning plugin plus its private schema + table. */
export interface PluginRowRef {
  readonly pluginId: string;
  readonly schema: string;
  readonly table: string;
  readonly rowId: string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const HOST_COLUMN_PREFIX = "caelo_";

/** Identifiers come from manifests and snapshot rows; re-check before interpolating. */
function assertIdent(value: string, label: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(`plugin row: refusing ${label} "${value}" (must match ${IDENT_RE})`);
  }
}

function qualifiedTable(schema: string, table: string) {
  assertIdent(schema, "schema");
  assertIdent(table, "table");
  return sql.raw(`"${schema}"."${table}"`);
}

function parseState(raw: unknown): PluginRowState {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as PluginRowState;
}

/** A live row (from `to_jsonb`) as a snapshot state: host columns dropped. */
export function rowToState(row: Readonly<Record<string, unknown>>): PluginRowState {
  const values = Object.fromEntries(
    Object.entries(row).filter(([k]) => !k.startsWith(HOST_COLUMN_PREFIX)),
  );
  const deleted = row.caelo_deleted_at;
  const version = row.caelo_version;
  if (typeof version !== "number") {
    throw new Error(
      "plugin row: live row has no caelo_version — the table predates migration of its host columns",
    );
  }
  return {
    schemaVersion: 1,
    values,
    deletedAt: deleted === null || deleted === undefined ? null : String(deleted),
    version,
  };
}

/** Attach one row state to an existing `site_snapshots` header. */
export async function insertPluginRowSnapshot(
  tx: TransactionRunner,
  siteSnapshotId: string,
  row: PluginRowRef,
  state: PluginRowState,
): Promise<void> {
  assertIdent(row.schema, "schema");
  assertIdent(row.table, "table");
  await tx.execute(sql`
    INSERT INTO plugin_row_snapshots
      (site_snapshot_id, plugin_id, schema_name, table_name, row_id, state)
    VALUES (
      ${siteSnapshotId}::uuid, ${row.pluginId}::uuid, ${row.schema}, ${row.table},
      ${row.rowId}::uuid, (${JSON.stringify(state)}::text)::jsonb
    )
  `);
}

/** Write one row snapshot (and its site_snapshots header) in `tx`. */
export async function emitPluginRowSnapshot(
  tx: TransactionRunner,
  input: PluginRowRef & {
    readonly actorId: string;
    readonly opKind: PluginRowOpKind;
    readonly chatBranchId: string | null;
    readonly chatTaskId: string | null;
    readonly state: PluginRowState;
  },
): Promise<void> {
  const header = (await tx.execute(sql`
    INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id)
    VALUES (
      ${input.actorId}::uuid,
      ${input.opKind},
      ${`${input.opKind} ${input.schema}.${input.table} ${input.rowId}`},
      ${input.chatTaskId},
      ${input.chatBranchId}
    )
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  const siteSnapshotId = header[0]?.id;
  if (!siteSnapshotId) throw new Error("plugin row snapshot: no site_snapshots id returned");
  await insertPluginRowSnapshot(tx, siteSnapshotId, input, input.state);
}

/**
 * The latest state per row recorded on `chatBranchId` for one table.
 * Rows the branch never touched are absent.
 *
 * @param rowIds restrict to these rows; omit for every row the branch touched
 */
export async function loadBranchRowStates(
  tx: TransactionRunner,
  input: {
    readonly pluginId: string;
    readonly table: string;
    readonly chatBranchId: string;
    readonly rowIds?: readonly string[];
  },
): Promise<Map<string, PluginRowState>> {
  const onlyRows =
    input.rowIds === undefined
      ? sql``
      : input.rowIds.length === 0
        ? sql`AND false`
        : sql`AND prs.row_id IN (${sql.join(
            input.rowIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (prs.row_id) prs.row_id::text AS row_id, prs.state
    FROM plugin_row_snapshots prs
    JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
    WHERE prs.plugin_id = ${input.pluginId}::uuid
      AND prs.table_name = ${input.table}
      AND ss.chat_branch_id = ${input.chatBranchId}::uuid
      -- issue #620: only pending branch snapshots (not staged, not undone).
      AND ss.staged_at IS NULL AND ss.undone_at IS NULL
      ${onlyRows}
    ORDER BY prs.row_id, ss.created_at DESC, prs.created_at DESC
  `)) as unknown as { row_id: string; state: unknown }[];
  const out = new Map<string, PluginRowState>();
  for (const r of rows) out.set(r.row_id, parseState(r.state));
  return out;
}

/**
 * Run `fn` with `caelo.plugin_id` set to `pluginId`, restoring the prior
 * value afterwards. Plugin tables are RLS-scoped to their plugin; the
 * publish and discard paths act on them for the Owner, one plugin at a
 * time, inside the Owner's transaction.
 */
export async function withPluginScope<T>(
  tx: TransactionRunner,
  pluginId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = (await tx.execute(
    sql`SELECT COALESCE(current_setting('caelo.plugin_id', true), '') AS v`,
  )) as unknown as { v: string }[];
  await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${pluginId}, true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${prior[0]?.v ?? ""}, true)`);
  }
}

/**
 * Apply a branch state to the live row and graduate it to main: every
 * value column, the tombstone, the version, and `caelo_chat_branch_id`
 * cleared. Values are cast through the table's own row type
 * (`jsonb_populate_record`), so each column keeps its declared type.
 * Must run in the plugin's RLS scope ({@link withPluginScope}).
 */
export async function applyPluginRowState(
  tx: TransactionRunner,
  row: PluginRowRef,
  state: PluginRowState,
): Promise<void> {
  const target = qualifiedTable(row.schema, row.table);
  const sets = Object.keys(state.values)
    .filter((c) => c !== "id")
    .map((c) => {
      assertIdent(c, "column");
      if (c.startsWith(HOST_COLUMN_PREFIX)) {
        throw new Error(`plugin row: snapshot carries host column "${c}"`);
      }
      return sql.raw(`"${c}" = r."${c}"`);
    });
  const deletedAt =
    state.deletedAt === null ? sql`NULL` : sql`COALESCE(t."caelo_deleted_at", now())`;
  const hostSets = [
    sql`"caelo_deleted_at" = ${deletedAt}`,
    sql`"caelo_version" = ${state.version}`,
    sql`"caelo_updated_at" = now()`,
    sql`"caelo_chat_branch_id" = NULL`,
  ];
  const updated = (await tx.execute(sql`
    UPDATE ${target} AS t
    SET ${sql.join([...sets, ...hostSets], sql`, `)}
    FROM jsonb_populate_record(NULL::${target}, (${JSON.stringify(state.values)}::text)::jsonb) AS r
    WHERE t.id = ${row.rowId}::uuid
    RETURNING t.id
  `)) as unknown as unknown[];
  if (updated.length === 0) {
    throw new Error(
      `plugin row: ${row.schema}.${row.table} ${row.rowId} has a branch state but no live row — it was removed outside the storage operations`,
    );
  }
}

/**
 * Drop what a branch created in plugin tables: rows inserted on the
 * branch are tombstoned and stay tagged, so no main-line read ever sees
 * them. Edits to main rows need no work — they only ever lived in
 * branch snapshots. Returns the number of rows tombstoned.
 *
 * @param rowIds issue #620 — restrict to these rows (an undo of one chat
 *   on the shared draft drops only the rows THAT chat created); omit to
 *   drop everything the branch created (discarding a whole branch).
 */
export async function discardBranchPluginRows(
  tx: TransactionRunner,
  chatBranchId: string,
  rowIds?: readonly string[],
): Promise<number> {
  if (rowIds !== undefined && rowIds.length === 0) return 0;
  const idList = (column: string) =>
    rowIds === undefined
      ? sql``
      : sql`AND ${sql.raw(column)} IN (${sql.join(
          rowIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const tables = (await tx.execute(sql`
    SELECT DISTINCT prs.plugin_id::text AS plugin_id, prs.schema_name, prs.table_name
    FROM plugin_row_snapshots prs
    JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
    WHERE ss.chat_branch_id = ${chatBranchId}::uuid ${idList("prs.row_id")}
  `)) as unknown as { plugin_id: string; schema_name: string; table_name: string }[];
  let dropped = 0;
  for (const t of tables) {
    const target = qualifiedTable(t.schema_name, t.table_name);
    const rows = await withPluginScope(
      tx,
      t.plugin_id,
      async () =>
        (await tx.execute(sql`
          UPDATE ${target}
          SET "caelo_deleted_at" = now(), "caelo_updated_at" = now()
          WHERE "caelo_chat_branch_id" = ${chatBranchId}::uuid AND "caelo_deleted_at" IS NULL
            ${idList("id")}
          RETURNING id
        `)) as unknown as unknown[],
    );
    dropped += rows.length;
  }
  return dropped;
}
