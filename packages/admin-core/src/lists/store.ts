// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — reading and writing list types, lists and page types as the
 * caller sees them (docs/lists.md §11).
 *
 * The three entities follow the content_instances pattern exactly:
 *
 *   - a chat that CREATES one inserts the live row tagged with its branch
 *     (`chat_branch_id`), invisible to every other branch until a merge
 *     clears the tag;
 *   - every later change on a branch lands only in the entity's snapshot
 *     table — the live row is untouched until Stage;
 *   - a write without a branch (system, the Owner outside a chat) changes
 *     the live row and snapshots it, so it is revertable.
 *
 * A read in a chat is the live rows the branch can see, each superseded by
 * the branch's newest PENDING snapshot of it (`pendingSnapshotSql`, the
 * boundary every overlay read uses). Every read goes through
 * {@link loadListEntities}, so no read inside a chat sees the live row
 * where the chat has changed it (the bug class of the predecessor of
 * lists, whose `get` read live).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ListItem, ListTypeDef, PageTypeDef } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../draft.js";
import type { SnapshotEntity } from "../snapshots/emit.js";
import type { ListState, ListTypeState, PageTypeState } from "../snapshots/state.js";
import {
  parseAndUpgradeListState,
  parseAndUpgradeListTypeState,
  parseAndUpgradePageTypeState,
} from "../snapshots/state-schemas.js";
import { jsonbParam } from "../sql-helpers.js";

/** The three list-model entity kinds (lock kinds and snapshot kinds alike). */
export type ListEntityKind = "listType" | "list" | "pageType";

interface KindSpec {
  readonly table: string;
  readonly snapshotTable: string;
  readonly idColumn: string;
}

/** Live table, snapshot table and the snapshot table's entity column per kind. */
export const LIST_ENTITY_TABLES: Readonly<Record<ListEntityKind, KindSpec>> = {
  listType: { table: "list_types", snapshotTable: "list_type_snapshots", idColumn: "list_type_id" },
  list: { table: "lists", snapshotTable: "list_snapshots", idColumn: "list_id" },
  pageType: { table: "page_types", snapshotTable: "page_type_snapshots", idColumn: "page_type_id" },
};

type StateOf<K extends ListEntityKind> = K extends "listType"
  ? ListTypeState
  : K extends "list"
    ? ListState
    : PageTypeState;

/** One entity as the caller sees it. */
export interface ListEntityView<K extends ListEntityKind> {
  readonly id: string;
  readonly state: StateOf<K>;
  /** ISO time of the newest change the caller sees (branch snapshot or live row). */
  readonly updatedAt: string;
  /** The live row is tagged with a branch (created there, not merged yet). */
  readonly createdOnBranch: boolean;
  /**
   * List types only: the slug of the plugin that ships this type
   * (migration 0357), null for a site type. A plugin's type is written by
   * the host from the plugin's manifest, never by a person or the AI.
   */
  readonly ownerPlugin: string | null;
}

export interface LoadListEntitiesOptions {
  readonly ids?: readonly string[];
  readonly slugs?: readonly string[];
  readonly includeDeleted?: boolean;
  /**
   * List types only: also return types of plugins that are not running
   * (archived with their plugin, `plugin_list_type_available`). Off for
   * every read that renders or edits lists — an inactive plugin's type
   * does not exist for them — on for the upsert lookup, which must refuse
   * reusing such a slug instead of colliding with the row.
   */
  readonly includeArchivedPluginTypes?: boolean;
}

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function parseJson(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}

function parseState<K extends ListEntityKind>(kind: K, raw: unknown): StateOf<K> {
  const parsed =
    kind === "listType"
      ? parseAndUpgradeListTypeState(raw)
      : kind === "list"
        ? parseAndUpgradeListState(raw)
        : parseAndUpgradePageTypeState(raw);
  return parsed as StateOf<K>;
}

type LiveRow = {
  id: string;
  slug: string;
  definition?: unknown;
  name?: string;
  purpose?: string;
  list_type_id?: string;
  items?: unknown;
  version: number | string;
  updated_at: string | Date;
  deleted_at: string | Date | null;
  chat_branch_id: string | null;
  owner_plugin?: string | null;
};

function liveState<K extends ListEntityKind>(kind: K, r: LiveRow): StateOf<K> {
  const version = typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version;
  const deletedAt = iso(r.deleted_at);
  if (kind === "list") {
    const state: ListState = {
      schemaVersion: 1,
      slug: r.slug,
      name: r.name ?? "",
      purpose: r.purpose ?? "",
      listTypeId: r.list_type_id ?? "",
      items: (parseJson(r.items) ?? []) as ListItem[],
      version,
      deletedAt,
    };
    return state as StateOf<K>;
  }
  const state: ListTypeState | PageTypeState = {
    schemaVersion: 1,
    slug: r.slug,
    definition: parseJson(r.definition) as ListTypeDef & PageTypeDef,
    version,
    deletedAt,
  };
  return state as StateOf<K>;
}

/**
 * The entities of `kind` the caller sees, ordered by slug: live rows of
 * main plus rows created on `branchId`, each replaced by the branch's
 * newest pending snapshot of it. Deleted ones are dropped unless
 * `includeDeleted`.
 */
export async function loadListEntities<K extends ListEntityKind>(
  tx: TransactionRunner,
  kind: K,
  branchId: string | null,
  opts: LoadListEntitiesOptions = {},
): Promise<ListEntityView<K>[]> {
  const spec = LIST_ENTITY_TABLES[kind];
  if (opts.ids !== undefined && opts.ids.length === 0) return [];
  if (opts.slugs !== undefined && opts.slugs.length === 0) return [];
  const visible = branchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const idFilter = opts.ids
    ? sql` AND id IN (${sql.join(
        opts.ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  // Slugs never change after create, so the live column filters correctly.
  const slugFilter = opts.slugs
    ? sql` AND slug IN (${sql.join(
        opts.slugs.map((s) => sql`${s}`),
        sql`, `,
      )})`
    : sql``;
  const columns: SQL =
    kind === "list"
      ? sql`name, purpose, list_type_id::text AS list_type_id, items`
      : kind === "listType"
        ? sql`definition,
              (SELECT p.slug FROM plugins p WHERE p.id = ${sql.raw(spec.table)}.plugin_id) AS owner_plugin`
        : sql`definition`;
  const availability =
    kind === "listType" && !opts.includeArchivedPluginTypes
      ? sql` AND plugin_list_type_available(plugin_id)`
      : sql``;
  // A soft-deleted live row is still loaded: a branch may have restored it
  // (an undo of the delete is a later snapshot).
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, slug, ${columns}, version, updated_at, deleted_at,
           chat_branch_id::text AS chat_branch_id
    FROM ${sql.raw(spec.table)}
    WHERE ${visible}${idFilter}${slugFilter}${availability}
    ORDER BY slug, created_at
  `)) as unknown as LiveRow[];
  if (rows.length === 0) return [];

  const overlay = new Map<string, { state: StateOf<K>; at: string }>();
  if (branchId) {
    const snap = (await tx.execute(sql`
      SELECT DISTINCT ON (es.${sql.raw(spec.idColumn)})
             es.${sql.raw(spec.idColumn)}::text AS id, es.state,
             to_char(ss.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
        FROM ${sql.raw(spec.snapshotTable)} es
        JOIN site_snapshots ss ON ss.id = es.site_snapshot_id
       WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
         AND es.${sql.raw(spec.idColumn)} IN (${sql.join(
           rows.map((r) => sql`${r.id}::uuid`),
           sql`, `,
         )})
       ORDER BY es.${sql.raw(spec.idColumn)}, ss.created_at DESC
    `)) as unknown as { id: string; state: unknown; at: string }[];
    for (const s of snap) {
      overlay.set(s.id, { state: parseState(kind, parseJson(s.state)), at: s.at });
    }
  }

  const out: ListEntityView<K>[] = [];
  for (const r of rows) {
    const o = overlay.get(r.id);
    const state = o ? o.state : liveState(kind, r);
    if (state.deletedAt !== null && !opts.includeDeleted) continue;
    out.push({
      id: r.id,
      state,
      updatedAt: o ? o.at : (iso(r.updated_at) ?? ""),
      createdOnBranch: r.chat_branch_id !== null,
      ownerPlugin: r.owner_plugin ?? null,
    });
  }
  return out;
}

/** One entity by id as the caller sees it (deleted included), or null. */
export async function loadListEntity<K extends ListEntityKind>(
  tx: TransactionRunner,
  kind: K,
  branchId: string | null,
  id: string,
): Promise<ListEntityView<K> | null> {
  const [hit] = await loadListEntities(tx, kind, branchId, { ids: [id], includeDeleted: true });
  return hit ?? null;
}

/** One entity by slug as the caller sees it (not deleted), or null. */
export async function loadListEntityBySlug<K extends ListEntityKind>(
  tx: TransactionRunner,
  kind: K,
  branchId: string | null,
  slug: string,
): Promise<ListEntityView<K> | null> {
  const [hit] = await loadListEntities(tx, kind, branchId, { slugs: [slug] });
  return hit ?? null;
}

/**
 * The entity an upsert by slug writes: the live one, else the most
 * recently changed deleted one (an upsert of a deleted slug revives it
 * under the same id, keeping its history and never colliding with the
 * old row's slug at merge), else null for a new entity.
 */
export async function loadListEntityForUpsert<K extends ListEntityKind>(
  tx: TransactionRunner,
  kind: K,
  branchId: string | null,
  slug: string,
): Promise<ListEntityView<K> | null> {
  const all = await loadListEntities(tx, kind, branchId, {
    slugs: [slug],
    includeDeleted: true,
    includeArchivedPluginTypes: true,
  });
  const live = all.find((e) => e.state.deletedAt === null);
  if (live) return live;
  return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** A state of any of the three kinds, as `emitSnapshot` takes it. */
export type ListSnapshotEntity = Extract<SnapshotEntity, { kind: ListEntityKind }>;

/**
 * Persist a write of one entity for the caller: a branch write touches
 * only a row it creates (tagged with the branch — later changes live in
 * the snapshot the caller emits); a write without a branch upserts the
 * live row. Returns the snapshot entity to emit.
 */
export async function persistListEntity(
  tx: TransactionRunner,
  actorId: string,
  branchId: string | null,
  entity: ListSnapshotEntity,
  isCreate: boolean,
): Promise<ListSnapshotEntity> {
  if (branchId === null) {
    await applyListEntityRow(tx, actorId, entity, null);
  } else if (isCreate) {
    await applyListEntityRow(tx, actorId, entity, branchId);
  }
  return entity;
}

/**
 * Upsert the live row of `entity` from its state, tagged with
 * `chatBranchId` (a branch create) or untagged (live write, merge,
 * revert — a branch-created row graduates).
 */
export async function applyListEntityRow(
  tx: TransactionRunner,
  actorId: string,
  entity: ListSnapshotEntity,
  chatBranchId: string | null,
): Promise<void> {
  const deletedAt = entity.state.deletedAt ? sql`now()` : sql`NULL`;
  if (entity.kind === "list") {
    const s = entity.state;
    await tx.execute(sql`
      INSERT INTO lists (id, slug, name, purpose, list_type_id, items, version, updated_by,
                         deleted_at, chat_branch_id)
      VALUES (${entity.entityId}::uuid, ${s.slug}, ${s.name}, ${s.purpose}, ${s.listTypeId}::uuid,
              ${jsonbParam(s.items)}, ${s.version}, ${actorId}::uuid, ${deletedAt},
              ${chatBranchId}::uuid)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        purpose = EXCLUDED.purpose,
        list_type_id = EXCLUDED.list_type_id,
        items = EXCLUDED.items,
        version = EXCLUDED.version,
        deleted_at = ${entity.state.deletedAt ? sql`COALESCE(lists.deleted_at, now())` : sql`NULL`},
        chat_branch_id = EXCLUDED.chat_branch_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `);
    return;
  }
  const table = entity.kind === "listType" ? "list_types" : "page_types";
  const s = entity.state;
  await tx.execute(sql`
    INSERT INTO ${sql.raw(table)} (id, slug, definition, version, updated_by, deleted_at, chat_branch_id)
    VALUES (${entity.entityId}::uuid, ${s.slug}, ${jsonbParam(s.definition)}, ${s.version},
            ${actorId}::uuid, ${deletedAt}, ${chatBranchId}::uuid)
    ON CONFLICT (id) DO UPDATE SET
      definition = EXCLUDED.definition,
      version = EXCLUDED.version,
      deleted_at = ${entity.state.deletedAt ? sql`COALESCE(${sql.raw(table)}.deleted_at, now())` : sql`NULL`},
      chat_branch_id = EXCLUDED.chat_branch_id,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `);
}
