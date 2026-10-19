// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the reads and writes the link migration needs
 * per entity kind, on main and on chat branches. Kept apart from the
 * engine (`migrate.ts`) so each half stays readable.
 *
 * Branch model (see `draft.ts`): a chat's edits live in PENDING snapshot
 * rows tagged with its branch (`site_snapshots.chat_branch_id`, not
 * staged, not undone); reads overlay the latest one per entity, and a
 * Stage / publish applies that latest state to main. Rows a chat CREATED
 * also exist live, tagged with the branch, but reads and the merge take
 * the snapshot state — so converting a branch means appending one more
 * pending snapshot per entity with the converted state, owned by the
 * same chat task as the state it replaces (undo and selective Stage keep
 * working per chat).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../draft.js";
import type { ContentInstanceState, ModuleState, StructuredSetState } from "../snapshots/state.js";

/**
 * Row locking for an applying run. The migration reads, converts in
 * memory and writes back; it runs at boot and from "Convert now" while
 * editors work, so an edit committed between the read and the write
 * would be overwritten with the converted OLD state. An applying run
 * therefore reads main-line rows `FOR UPDATE` (a concurrent writer waits
 * for the migration and then applies on top of the converted row; one
 * already in flight commits first and the read sees its result). A dry
 * run writes nothing and takes no locks, so it never blocks editors.
 */
interface LoadOptions {
  readonly lock: boolean;
}

function forUpdate(opts: LoadOptions): SQL {
  return opts.lock ? sql`FOR UPDATE` : sql``;
}

function parse<T>(raw: unknown): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

/** A main-line module as the migration reads it. */
export interface MainModuleRow {
  readonly id: string;
  readonly displayName: string;
  readonly html: string;
  readonly fields: unknown[];
}

/** Live main-line modules (not deleted, not branch-created). */
export async function loadMainModules(
  tx: TransactionRunner,
  opts: LoadOptions,
): Promise<MainModuleRow[]> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, display_name, html, fields
      FROM modules
     WHERE deleted_at IS NULL AND chat_branch_id IS NULL
     ORDER BY id
     ${forUpdate(opts)}
  `)) as unknown as { id: string; display_name: string; html: string; fields: unknown }[];
  return rows.map((r) => {
    const f = parse<unknown>(r.fields);
    return {
      id: r.id,
      displayName: r.display_name,
      html: r.html,
      fields: Array.isArray(f) ? f : [],
    };
  });
}

/** Every module's stored field list (deleted ones too: an instance may outlive its module's deletion). */
export async function loadAllModuleFields(
  tx: TransactionRunner,
): Promise<Map<string, { name: string; fields: unknown[] }>> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, display_name, fields FROM modules
  `)) as unknown as { id: string; display_name: string; fields: unknown }[];
  const out = new Map<string, { name: string; fields: unknown[] }>();
  for (const r of rows) {
    const f = parse<unknown>(r.fields);
    out.set(r.id, { name: r.display_name, fields: Array.isArray(f) ? f : [] });
  }
  return out;
}

/** A main-line content instance as the migration reads it. */
export interface MainInstanceRow {
  readonly id: string;
  readonly moduleId: string;
  readonly label: string | null;
  readonly values: Record<string, unknown>;
}

/** Live main-line content instances; see {@link LoadOptions} for `lock`. */
export async function loadMainInstances(
  tx: TransactionRunner,
  opts: LoadOptions,
): Promise<MainInstanceRow[]> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, module_id::text AS module_id, COALESCE(display_name, slug) AS label, "values"
      FROM content_instances
     WHERE deleted_at IS NULL AND chat_branch_id IS NULL
     ORDER BY id
     ${forUpdate(opts)}
  `)) as unknown as { id: string; module_id: string; label: string | null; values: unknown }[];
  return rows.map((r) => ({
    id: r.id,
    moduleId: r.module_id,
    label: r.label,
    values: parse<Record<string, unknown> | null>(r.values) ?? {},
  }));
}

/** A structured set as the migration reads it. */
export interface MainSetRow {
  readonly id: string;
  readonly kind: string;
  readonly slug: string;
  readonly displayName: string;
  readonly items: unknown[];
}

/** Every structured set; see {@link LoadOptions} for `lock`. */
export async function loadMainSets(
  tx: TransactionRunner,
  opts: LoadOptions,
): Promise<MainSetRow[]> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, kind, slug, display_name, items FROM structured_sets ORDER BY id
     ${forUpdate(opts)}
  `)) as unknown as {
    id: string;
    kind: string;
    slug: string;
    display_name: string;
    items: unknown;
  }[];
  return rows.map((r) => {
    const items = parse<unknown>(r.items);
    return {
      id: r.id,
      kind: r.kind,
      slug: r.slug,
      displayName: r.display_name,
      items: Array.isArray(items) ? items : [],
    };
  });
}

/**
 * Branches with pending work that still belongs to a live chat. A
 * discarded chat's leftovers are never merged, so they are not migrated.
 */
export async function loadPendingBranches(tx: TransactionRunner): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ss.chat_branch_id::text AS branch_id
      FROM site_snapshots ss
     WHERE ss.chat_branch_id IS NOT NULL AND ${pendingSnapshotSql()}
       AND EXISTS (
         SELECT 1 FROM chat_sessions cs
          WHERE cs.chat_branch_id = ss.chat_branch_id AND cs.discarded_at IS NULL
       )
     ORDER BY 1
  `)) as unknown as { branch_id: string }[];
  return rows.map((r) => r.branch_id);
}

/**
 * Serialize an applying run against the chats writing on `branchId`.
 * A chat's write takes its entity's `chat_entity_locks` row `FOR UPDATE`
 * before it appends a pending state (`locks.ts`), and the row stays
 * while the state is pending. Locking every lock row the branch holds
 * BEFORE reading its states means a chat write in flight commits first
 * (and is read), and one that starts later waits for the migration and
 * appends on top of the converted state — never under it.
 */
export async function lockBranchEntities(tx: TransactionRunner, branchId: string): Promise<void> {
  await tx.execute(sql`
    SELECT 1 FROM chat_entity_locks
     WHERE chat_branch_id = ${branchId}::uuid
       AND entity_kind IN ('module', 'contentInstance', 'structuredSet', 'pluginRow')
     ORDER BY entity_kind, entity_id
     FOR UPDATE
  `);
}

/** The latest pending state of one entity on a branch, with its owning chat task. */
export interface BranchState<S> {
  readonly entityId: string;
  readonly state: S;
  readonly chatTaskId: string | null;
}

const SNAPSHOT_TABLES = {
  module: { table: "module_snapshots", id: "module_id" },
  contentInstance: { table: "content_instance_snapshots", id: "content_instance_id" },
  structuredSet: { table: "structured_set_snapshots", id: "structured_set_id" },
} as const;

type SnapshotKind = keyof typeof SNAPSHOT_TABLES;
type StateOf<K extends SnapshotKind> = K extends "module"
  ? ModuleState
  : K extends "contentInstance"
    ? ContentInstanceState
    : StructuredSetState;

/**
 * The latest pending state per entity of `kind` on `branchId`.
 *
 * @param ids restrict to these entities; omit for every one the branch touched.
 */
export async function loadBranchStates<K extends SnapshotKind>(
  tx: TransactionRunner,
  kind: K,
  branchId: string,
  ids?: readonly string[],
): Promise<BranchState<StateOf<K>>[]> {
  const t = SNAPSHOT_TABLES[kind];
  if (ids !== undefined && ids.length === 0) return [];
  const table = sql.raw(t.table);
  const col = sql.raw(`x.${t.id}`);
  const idFilter: SQL =
    ids === undefined
      ? sql``
      : sql`AND ${col} IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (${col}) ${col}::text AS id, x.state, ss.chat_task_id::text AS task
      FROM ${table} x
      JOIN site_snapshots ss ON ss.id = x.site_snapshot_id
     WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()} ${idFilter}
     ORDER BY ${col}, ss.created_at DESC
  `)) as unknown as { id: string; state: unknown; task: string | null }[];
  return rows.map((r) => ({
    entityId: r.id,
    state: parse<StateOf<K>>(r.state),
    chatTaskId: r.task,
  }));
}

/** The chat task owning the latest pending state of each plugin row on a branch. */
export async function loadPluginRowTasks(
  tx: TransactionRunner,
  branchId: string,
  pluginId: string,
  table: string,
): Promise<Map<string, string | null>> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (prs.row_id) prs.row_id::text AS row_id, ss.chat_task_id::text AS task
      FROM plugin_row_snapshots prs
      JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
     WHERE prs.plugin_id = ${pluginId}::uuid AND prs.table_name = ${table}
       AND ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
     ORDER BY prs.row_id, ss.created_at DESC, prs.created_at DESC
  `)) as unknown as { row_id: string; task: string | null }[];
  return new Map(rows.map((r) => [r.row_id, r.task]));
}
