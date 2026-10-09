// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part A — the site's shared draft.
 *
 * Every new chat binds to ONE branch per site, the draft (`site_draft`),
 * instead of opening its own branch. Chats become conversations over a
 * shared working state: two chats see each other's changes in preview, and
 * there are no locks between them (optimistic versioning instead — see
 * `locks.ts`). Experiments ("try a redesign") and site migrations bind to
 * an isolated branch; chats that existed before the draft keep their own
 * branches ('legacy') until they are staged or discarded.
 *
 * What is pending is a per-SNAPSHOT property (`site_snapshots.staged_at` /
 * `undone_at`): a Stage of selected draft chats consumes exactly the
 * snapshots it merged, and "undo this chat" drops exactly that chat's
 * snapshots. Each snapshot belongs to the chat named by its chat task (a
 * subagent's task maps to its parent chat — `caelo_chat_owner`).
 *
 * Two selections are computed here, both CLOSED so nothing is half-shipped
 * or half-undone:
 *   - a Stage of chats S takes every pending snapshot of every entity S
 *     touched (the merge ships an entity's latest draft state, which may
 *     include another chat's later edit — that chat is reported), plus
 *     every plugin row when one is included (plugin rows can shape URLs and
 *     go live together);
 *   - an undo of chat C drops C's snapshots plus every LATER pending
 *     snapshot of the same entities (those were built on C's change), plus
 *     snapshots that reference rows C created — the other chats affected
 *     are reported so the AI warns and asks before confirming.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import { lockedEntityLabel } from "./entity-labels.js";
import type { LockedEntityKind } from "./locks.js";

/** How a chat is bound to a branch. */
export type BranchKind = "draft" | "experiment" | "migration" | "legacy";

/** A chat's binding plus the session facts the stage/undo paths need. */
export interface ChatBinding {
  readonly chatSessionId: string;
  readonly branchId: string;
  readonly kind: BranchKind;
  readonly createdBy: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly discardedAt: string | null;
}

/** The draft branch id. Fails loudly when the 0246 seed row is missing. */
export async function draftBranchId(tx: TransactionRunner): Promise<string> {
  const rows = (await tx.execute(sql`
    SELECT branch_id::text AS branch_id FROM site_draft WHERE id = 1
  `)) as unknown as { branch_id: string }[];
  const id = rows[0]?.branch_id;
  if (!id) {
    throw new Error(
      "site_draft has no row — migration 0246 seeds it; the shared draft branch cannot be resolved",
    );
  }
  return id;
}

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Load a chat's binding, or null when the session does not exist. */
export async function loadChatBinding(
  tx: TransactionRunner,
  chatSessionId: string,
): Promise<ChatBinding | null> {
  const rows = (await tx.execute(sql`
    SELECT chat_branch_id::text AS branch_id, branch_kind, created_by::text AS created_by,
           title, published_at, archived_at, discarded_at
    FROM chat_sessions WHERE id = ${chatSessionId}::uuid
  `)) as unknown as {
    branch_id: string;
    branch_kind: BranchKind;
    created_by: string;
    title: string;
    published_at: string | Date | null;
    archived_at: string | Date | null;
    discarded_at: string | Date | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    chatSessionId,
    branchId: r.branch_id,
    kind: r.branch_kind,
    createdBy: r.created_by,
    title: r.title,
    publishedAt: iso(r.published_at),
    archivedAt: iso(r.archived_at),
    discardedAt: iso(r.discarded_at),
  };
}

/**
 * SQL predicate: the snapshot header under `alias` is still pending (not
 * merged by a Stage, not undone). Every branch-overlay read and every
 * pending-change listing filters with it.
 */
export function pendingSnapshotSql(alias = "ss"): SQL {
  return sql.raw(`${alias}.staged_at IS NULL AND ${alias}.undone_at IS NULL`);
}

/**
 * SQL predicate: the header under `alias` is one of THIS chat's pending
 * changes — on its branch, pending, and (on the shared draft) written by
 * this chat or one of its subagents.
 */
export function chatPendingSql(binding: ChatBinding, alias = "ss"): SQL {
  const owner =
    binding.kind === "draft"
      ? sql` AND caelo_chat_owner(${sql.raw(alias)}.chat_task_id) = ${binding.chatSessionId}::uuid`
      : sql``;
  return sql`${sql.raw(alias)}.chat_branch_id = ${binding.branchId}::uuid AND ${pendingSnapshotSql(alias)}${owner}`;
}

/**
 * Correlated form of {@link chatPendingSql} for queries that walk
 * `chat_sessions` (alias `cs`) and count each chat's pending headers
 * (alias `ss`).
 */
export function sessionPendingSql(csAlias = "cs", ssAlias = "ss"): SQL {
  return sql.raw(
    `${ssAlias}.chat_branch_id = ${csAlias}.chat_branch_id AND ${ssAlias}.staged_at IS NULL AND ${ssAlias}.undone_at IS NULL` +
      ` AND (${csAlias}.branch_kind <> 'draft' OR caelo_chat_owner(${ssAlias}.chat_task_id) = ${csAlias}.id)`,
  );
}

/** Entity snapshot tables and the key prefix of the entity each row records. */
const ENTITY_TABLES: readonly { table: string; column: string; key: string }[] = [
  { table: "module_snapshots", column: "module_id", key: "module" },
  { table: "template_snapshots", column: "template_id", key: "template" },
  { table: "page_snapshots", column: "page_id", key: "page" },
  { table: "page_layout_snapshots", column: "page_id", key: "pageLayout" },
  {
    table: "page_module_content_snapshots",
    column: "page_module_content_id",
    key: "pageModuleContent",
  },
  { table: "structured_set_snapshots", column: "structured_set_id", key: "structuredSet" },
  { table: "content_instance_snapshots", column: "content_instance_id", key: "contentInstance" },
  { table: "theme_snapshots", column: "theme_id", key: "theme" },
  { table: "plugin_row_snapshots", column: "row_id", key: "pluginRow" },
];

/** One pending header with the chat it belongs to and the entities it records. */
interface PendingHeader {
  readonly id: string;
  /** Owning chat (null = written outside any chat). */
  readonly owner: string | null;
  readonly createdAt: string;
  /** `kind:id` per entity row under the header. */
  readonly keys: readonly string[];
}

async function pendingHeaders(
  tx: TransactionRunner,
  branchId: string,
  bound: string | null,
): Promise<PendingHeader[]> {
  const boundSql = bound ? sql` AND ss.created_at <= ${bound}::timestamptz` : sql``;
  const entityUnion = sql.join(
    ENTITY_TABLES.map(
      (t) =>
        sql`SELECT site_snapshot_id AS h, ${t.key} || ':' || ${sql.raw(t.column)}::text AS k FROM ${sql.raw(t.table)} WHERE site_snapshot_id IN (SELECT id FROM pending)`,
    ),
    sql` UNION ALL `,
  );
  const rows = (await tx.execute(sql`
    WITH pending AS (
      SELECT ss.id, ss.chat_task_id, ss.created_at FROM site_snapshots ss
      WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}${boundSql}
    ),
    ents AS (${entityUnion})
    SELECT p.id::text AS id,
           caelo_chat_owner(p.chat_task_id)::text AS owner,
           to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           COALESCE(array_agg(e.k) FILTER (WHERE e.k IS NOT NULL), '{}') AS keys
    FROM pending p LEFT JOIN ents e ON e.h = p.id
    GROUP BY p.id, p.chat_task_id, p.created_at
    ORDER BY p.created_at, p.id
  `)) as unknown as { id: string; owner: string | null; created_at: string; keys: string[] }[];
  return rows.map((r) => ({ id: r.id, owner: r.owner, createdAt: r.created_at, keys: r.keys }));
}

/** Another chat a draft selection reaches into, with what it touches there. */
export interface AffectedChat {
  /** null = changes written outside any chat. */
  readonly chatSessionId: string | null;
  readonly title: string;
  readonly labels: readonly string[];
}

async function chatTitles(
  tx: TransactionRunner,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, title FROM chat_sessions
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; title: string }[];
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** Human label of an entity key (`kind:id`). */
async function keyLabel(tx: TransactionRunner, key: string): Promise<string> {
  const [kind, id] = key.split(":") as [string, string];
  const lockKind: Partial<Record<string, LockedEntityKind>> = {
    module: "module",
    template: "template",
    page: "page",
    pageLayout: "page",
    structuredSet: "structuredSet",
    contentInstance: "contentInstance",
    theme: "theme",
  };
  const k = lockKind[kind];
  if (k) {
    const label = await lockedEntityLabel(tx, k, id);
    return kind === "pageLayout" ? `${label} (sections)` : label;
  }
  if (kind === "pageModuleContent") {
    const rows = (await tx.execute(sql`
      SELECT COALESCE(p.title, p.slug) AS label FROM page_module_content pmc
      JOIN pages p ON p.id = pmc.page_id WHERE pmc.id = ${id}::uuid
    `)) as unknown as { label: string }[];
    return rows[0] ? `${rows[0].label} (content)` : `content ${id}`;
  }
  return `${kind} ${id}`;
}

async function describeAffected(
  tx: TransactionRunner,
  headers: readonly PendingHeader[],
  selected: ReadonlySet<string>,
  excludeOwners: ReadonlySet<string>,
): Promise<AffectedChat[]> {
  const byOwner = new Map<string | null, Set<string>>();
  for (const h of headers) {
    if (!selected.has(h.id)) continue;
    if (h.owner !== null && excludeOwners.has(h.owner)) continue;
    const set = byOwner.get(h.owner) ?? new Set<string>();
    for (const k of h.keys) set.add(k);
    byOwner.set(h.owner, set);
  }
  const titles = await chatTitles(
    tx,
    [...byOwner.keys()].filter((o): o is string => o !== null),
  );
  const out: AffectedChat[] = [];
  for (const [owner, keys] of byOwner) {
    const labels: string[] = [];
    for (const k of [...keys].slice(0, 20)) labels.push(await keyLabel(tx, k));
    out.push({
      chatSessionId: owner,
      title: owner === null ? "changes made outside a chat" : (titles.get(owner) ?? owner),
      labels,
    });
  }
  return out;
}

/** The closed set of draft snapshots a Stage of `chatSessionIds` merges. */
export interface DraftStageSelection {
  readonly headerIds: readonly string[];
  /** Entity keys (`kind:id`) the selection merges. */
  readonly entityKeys: readonly string[];
  /** Other chats whose changes ride along because they share an entity. */
  readonly alsoIncludes: readonly AffectedChat[];
}

/**
 * The pending draft snapshots a Stage of the given draft chats merges:
 * their own snapshots, closed over shared entities (all pending snapshots
 * of every entity they touched) and over plugin rows (all or none), plus
 * changes written outside any chat (they belong to nobody, so the next
 * Stage ships them — reported).
 *
 * @param bound only headers created at or before this ISO time (the merge
 *   time; finalize recomputes the same set with it).
 */
export async function draftStageSelection(
  tx: TransactionRunner,
  branchId: string,
  chatSessionIds: readonly string[],
  bound: string | null,
): Promise<DraftStageSelection> {
  const headers = await pendingHeaders(tx, branchId, bound);
  const chats = new Set(chatSessionIds);
  const selected = new Set(
    headers.filter((h) => h.owner === null || chats.has(h.owner)).map((h) => h.id),
  );
  const keys = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of headers) if (selected.has(h.id)) for (const k of h.keys) keys.add(k);
    const pluginRows = [...keys].some((k) => k.startsWith("pluginRow:"));
    for (const h of headers) {
      if (selected.has(h.id)) continue;
      if (h.keys.some((k) => keys.has(k) || (pluginRows && k.startsWith("pluginRow:")))) {
        selected.add(h.id);
        changed = true;
      }
    }
  }
  return {
    headerIds: headers.filter((h) => selected.has(h.id)).map((h) => h.id),
    entityKeys: [...keys],
    alsoIncludes: await describeAffected(tx, headers, selected, chats),
  };
}

/** A row the undone chat created on the draft (soft-deleted by the undo). */
export interface CreatedRow {
  readonly table: "pages" | "modules" | "templates" | "content_instances";
  readonly id: string;
}

/** What "undo this chat" drops from the draft. */
export interface DraftUndoSelection {
  readonly headerIds: readonly string[];
  readonly createdRows: readonly CreatedRow[];
  /**
   * Plugin rows first recorded inside the selection. Tombstoned when they
   * were created on the draft; a main row's id here is a no-op (its edit
   * simply stops being pending).
   */
  readonly pluginRowIds: readonly string[];
  /** Other chats whose later changes are undone too — warn, then confirm. */
  readonly overlap: readonly AffectedChat[];
}

const CREATED_TABLE: Readonly<Record<string, CreatedRow["table"]>> = {
  page: "pages",
  module: "modules",
  template: "templates",
  contentInstance: "content_instances",
};

/**
 * The pending draft snapshots "undo chat C" drops: C's own snapshots; for
 * every entity they touch, every LATER pending snapshot of that entity
 * (built on C's change, so it cannot survive without it); and every pending
 * snapshot that references a row C created (the row is deleted). Closed:
 * repeats until nothing more joins.
 */
export async function draftUndoSelection(
  tx: TransactionRunner,
  branchId: string,
  chatSessionId: string,
): Promise<DraftUndoSelection> {
  const headers = await pendingHeaders(tx, branchId, null);
  const selected = new Set(headers.filter((h) => h.owner === chatSessionId).map((h) => h.id));
  const created = new Map<string, CreatedRow>();
  const pluginRowIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    // Earliest selected change per entity: everything after it goes too.
    const earliest = new Map<string, string>();
    for (const h of headers) {
      if (!selected.has(h.id)) continue;
      for (const k of h.keys) {
        const at = earliest.get(k);
        if (at === undefined || h.createdAt < at) earliest.set(k, h.createdAt);
      }
    }
    for (const h of headers) {
      if (selected.has(h.id)) continue;
      if (h.keys.some((k) => earliest.has(k) && h.createdAt > (earliest.get(k) ?? ""))) {
        selected.add(h.id);
        changed = true;
      }
    }
    // Rows created inside the selection (still tagged with the draft and
    // first recorded by a selected header) are deleted by the undo; any
    // other pending change pointing at them must go with them.
    for (const key of earliest.keys()) {
      const [kind, id] = key.split(":") as [string, string];
      const firstHeader = headers.find((h) => h.keys.includes(key));
      if (!firstHeader || !selected.has(firstHeader.id)) continue;
      if (kind === "pluginRow") {
        pluginRowIds.add(id);
        continue;
      }
      const table = CREATED_TABLE[kind];
      if (!table || created.has(key)) continue;
      const rows = (await tx.execute(sql`
        SELECT 1 FROM ${sql.raw(table)} WHERE id = ${id}::uuid AND chat_branch_id = ${branchId}::uuid
      `)) as unknown as unknown[];
      if (rows.length === 0) continue;
      created.set(key, { table, id });
      const referencing = (await tx.execute(sql`
        SELECT DISTINCT ss.id::text AS id FROM site_snapshots ss
        WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
          AND (${sql.join(
            ENTITY_TABLES.map(
              (t) =>
                sql`EXISTS (SELECT 1 FROM ${sql.raw(t.table)} es WHERE es.site_snapshot_id = ss.id AND es.state::text LIKE ${`%${id}%`})`,
            ),
            sql` OR `,
          )})
      `)) as unknown as { id: string }[];
      for (const r of referencing) {
        if (!selected.has(r.id)) {
          selected.add(r.id);
          changed = true;
        }
      }
    }
  }
  return {
    headerIds: headers.filter((h) => selected.has(h.id)).map((h) => h.id),
    createdRows: [...created.values()],
    pluginRowIds: [...pluginRowIds],
    overlap: await describeAffected(tx, headers, selected, new Set([chatSessionId])),
  };
}

/**
 * Release draft locks over entities the draft no longer has pending
 * changes on. Draft locks exist only to keep isolated branches (experiments,
 * migrations, legacy chats) from diverging with the draft; once a Stage or
 * an undo consumed an entity's draft changes, its lock has no purpose.
 * Live-write kinds (layout, redirect, site settings/defaults) never have
 * pending snapshots and are released here too.
 */
export async function releaseIdleDraftLocks(
  tx: TransactionRunner,
  branchId: string,
): Promise<void> {
  const touched = (kinds: readonly string[], idColumn: string): SQL =>
    sql.join(
      kinds.map((key) => {
        const t = ENTITY_TABLES.find((e) => e.key === key);
        if (!t) throw new Error(`releaseIdleDraftLocks: unknown entity key ${key}`);
        const col = key === "pageModuleContent" ? "page_id" : t.column;
        return sql`EXISTS (
          SELECT 1 FROM ${sql.raw(t.table)} es JOIN site_snapshots ss ON ss.id = es.site_snapshot_id
          WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
            AND es.${sql.raw(col)} = ${sql.raw(idColumn)}
        )`;
      }),
      sql` OR `,
    );
  await tx.execute(sql`
    DELETE FROM chat_entity_locks l
    WHERE l.chat_branch_id = ${branchId}::uuid
      AND NOT CASE l.entity_kind
        WHEN 'module' THEN ${touched(["module"], "l.entity_id")}
        WHEN 'template' THEN ${touched(["template"], "l.entity_id")}
        WHEN 'page' THEN ${touched(["page", "pageLayout", "pageModuleContent"], "l.entity_id")}
        WHEN 'pageLayout' THEN ${touched(["pageLayout"], "l.entity_id")}
        WHEN 'structuredSet' THEN ${touched(["structuredSet"], "l.entity_id")}
        WHEN 'contentInstance' THEN ${touched(["contentInstance"], "l.entity_id")}
        WHEN 'theme' THEN ${touched(["theme"], "l.entity_id")}
        WHEN 'pluginRow' THEN ${touched(["pluginRow"], "l.entity_id")}
        ELSE false
      END
  `);
}
