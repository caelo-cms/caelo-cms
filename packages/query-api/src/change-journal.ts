// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — reading the entity change journal (migration 0430,
 * `docs/dev/state-and-changes.md`). Every derived structure that needs to
 * know "what changed" reads it through here; nothing invents its own
 * signal any more.
 *
 * Two ways to read:
 *
 * - **Freshness of a cached read** ({@link checkJournalMark}): an
 *   in-memory cache (the site view, the
 *   font usage scan) records the Postgres snapshot it read under and later
 *   proves in one statement that no journal row matching its filter became
 *   visible since. No counter row, so writers never serialise on it.
 * - **A persisted consumer** ({@link pollChanges} / {@link commitChanges}):
 *   a cursor over the journal for asynchronous consumers (plugin reactions,
 *   background scans, the live fan-out), with a single-instance claim.
 *
 * Cursor semantics (rule 4 of the contract). A cursor is a
 * `pg_current_snapshot()`. Delivered are the rows visible now and not
 * visible in the cursor, so a transaction that started before the last
 * read but committed after it is delivered on the next read — never
 * skipped, which an `id > cursor` read does. The re-scanned tail starts at
 * the cursor's xmin: a long transaction (a build) holds xmin back and makes
 * every read re-check the rows above it, a cost bounded by the writes
 * during that transaction. A paged read pins its target snapshot, so rows
 * committing between pages are left for the next round instead of being
 * marked seen without delivery.
 *
 * Retention: rows older than the retention window are deleted by
 * {@link collectJournalGarbage}, which records a horizon. A cursor whose
 * xmin is at or below a horizon may have lost rows: the read reports
 * `needsRebuild` and the consumer runs its rebuild-from-source op instead.
 * GC never waits for a consumer, so a dead one holds nothing back.
 */

import { sql } from "drizzle-orm";
import type { TransactionRunner } from "./operation.js";

/** One journal row as consumers see it. */
export interface JournalChange {
  /** The writing transaction (xid8, as text). */
  readonly xid: string;
  /** The physical table (`plugin_<slug>.<table>` for plugin storage). */
  readonly table: string;
  readonly rowId: string;
  readonly kind: string;
  readonly op: "insert" | "update" | "delete" | "truncate";
  /** Columns an update changed; null = every column. */
  readonly changedColumns: readonly string[] | null;
  readonly parentId: string | null;
  readonly pluginId: string | null;
  /** The branch the change is on; null = main (a live write). */
  readonly chatBranchId: string | null;
  readonly ownerChatSessionId: string | null;
  readonly siteSnapshotId: string | null;
  readonly prevSnapshotId: string | null;
  readonly opName: string | null;
  readonly createdAt: string;
}

/**
 * Which journal rows a reader cares about. Empty `kinds` matches nothing:
 * a reader names what it derives from.
 */
export interface JournalFilter {
  readonly kinds: readonly string[];
  /**
   * Only rows of main (`null` branch) plus rows of this branch. Omitted =
   * every branch.
   */
  readonly branchId?: string | null;
  /** Kinds {@link branchId} does not narrow (they count on every branch). */
  readonly unscopedKinds?: readonly string[];
  /**
   * Operations {@link branchId} does not narrow. A journal row names the
   * branch a row is on AFTER the change; an update that moved a snapshot
   * to another branch (a lock takeover) changed the branch it left too.
   */
  readonly unscopedOps?: readonly JournalChange["op"][];
  /** Per kind, the operations that count (default: all). */
  readonly kindOps?: Readonly<Record<string, readonly JournalChange["op"][]>>;
  /**
   * Per kind, the columns whose updates count; an update of a row of that
   * kind that changed none of them is ignored (inserts, deletes and
   * truncates always count). For `plugins`, only slug and source code
   * change what the font scan reads.
   */
  readonly columns?: Readonly<Record<string, readonly string[]>>;
  /**
   * Plugin-owned kinds (`plugin_storage`, `plugin_row`, `plugin_file`)
   * only of these plugins: a plugin consumer never sees another plugin's
   * rows. Core kinds are not narrowed.
   */
  readonly pluginIds?: readonly string[];
  /** Plugin storage rows only of these tables (bare names, with {@link pluginIds}). */
  readonly pluginTables?: readonly string[];
}

/** `ARRAY[...]` bound as ONE parameter (rule 7: no per-element bind lists). */
export function textArray(values: readonly string[]) {
  return sql`ARRAY(SELECT jsonb_array_elements_text((${JSON.stringify(values)}::text)::jsonb))`;
}

/** {@link textArray} for uuids. */
export function uuidArray(values: readonly string[]) {
  return sql`ARRAY(SELECT jsonb_array_elements_text((${JSON.stringify(values)}::text)::jsonb)::uuid)`;
}

function filterSql(filter: JournalFilter, alias = "ec") {
  const a = sql.raw(alias);
  const parts = [sql`${a}.kind = ANY(${textArray(filter.kinds)})`];
  if (filter.branchId !== undefined) {
    const scoped =
      filter.branchId === null
        ? sql`${a}.chat_branch_id IS NULL`
        : sql`(${a}.chat_branch_id IS NULL OR ${a}.chat_branch_id = ${filter.branchId}::uuid)`;
    const unscoped = [
      ...(filter.unscopedKinds && filter.unscopedKinds.length > 0
        ? [sql`${a}.kind = ANY(${textArray(filter.unscopedKinds)})`]
        : []),
      ...(filter.unscopedOps && filter.unscopedOps.length > 0
        ? [sql`${a}.op = ANY(${textArray(filter.unscopedOps)})`]
        : []),
    ];
    parts.push(unscoped.length > 0 ? sql`(${sql.join([...unscoped, scoped], sql` OR `)})` : scoped);
  }
  for (const [kind, ops] of Object.entries(filter.kindOps ?? {})) {
    parts.push(sql`(${a}.kind <> ${kind} OR ${a}.op = ANY(${textArray(ops)}))`);
  }
  for (const [kind, columns] of Object.entries(filter.columns ?? {})) {
    parts.push(
      sql`(${a}.kind <> ${kind} OR ${a}.op <> 'update' OR ${a}.changed_columns IS NULL
           OR ${a}.changed_columns && ${textArray(columns)})`,
    );
  }
  if (filter.pluginIds !== undefined) {
    parts.push(
      sql`(${a}.kind NOT IN ('plugin_storage', 'plugin_row', 'plugin_file')
           OR ${a}.plugin_id = ANY(${uuidArray(filter.pluginIds)}))`,
    );
  }
  if (filter.pluginTables !== undefined) {
    // A live storage row names its table as `plugin_<slug>.<table>`; a
    // branch row snapshot carries the bare table as its parent.
    parts.push(
      sql`(${a}.kind NOT IN ('plugin_storage', 'plugin_row')
           OR (CASE WHEN ${a}.kind = 'plugin_row' THEN ${a}.parent_id
                    ELSE split_part(${a}.table_name, '.', 2) END) = ANY(${textArray(filter.pluginTables)}))`,
    );
  }
  return sql.join(parts, sql` AND `);
}

/**
 * Where a cached read stands in the journal: taken in the same statement
 * as (or before) the read it describes.
 */
export interface JournalMark {
  /** `pg_current_snapshot()` as text. */
  readonly snapshot: string;
  /**
   * The reading transaction's own xid, when it had one. Postgres counts a
   * transaction's own xid as visible in its snapshots, but the read saw
   * only that transaction's writes made BEFORE it; a later write by it
   * must still invalidate, so freshness treats this xid as unseen.
   */
  readonly ownXid: string | null;
  /**
   * The reading transaction had already written a row matching the
   * filter: the read saw uncommitted state, which a rollback would undo
   * without a journal row. Such a read must not be cached.
   */
  readonly dirty: boolean;
}

/** What {@link checkJournalMark} answered. */
export interface JournalCheck {
  /** The cached read is still exactly what `tx` would read now. */
  readonly fresh: boolean;
  /**
   * Where a read that starts now stands: the mark to store with a fresh
   * read when the cached one is stale (or there is none).
   */
  readonly mark: JournalMark;
}

/**
 * One statement per cached read, hit or miss: prove `cached` still fresh
 * as far as `filter` reaches, and take the mark for a read that starts
 * now. Taken BEFORE a multi-statement read, the mark makes a change that
 * commits during the read unseen, so it invalidates once — safe; taken
 * after, it would be marked seen while the read may have missed it.
 *
 * `cached` is fresh when, under the reader's single snapshot:
 * - the reader has seen every transaction the marked snapshot saw (so
 *   nothing the cached read included is invisible to this reader — a
 *   build transaction older than the cache must not be served it);
 * - no matching journal row the reader can see (its own included) is
 *   unseen by the mark;
 * - no garbage collection removed a row this comparison needs.
 */
export async function checkJournalMark(
  tx: TransactionRunner,
  cached: Pick<JournalMark, "snapshot" | "ownXid"> | null,
  filter: JournalFilter,
): Promise<JournalCheck> {
  const rows = (await tx.execute(sql`
    WITH c AS (SELECT ${cached?.snapshot ?? null}::pg_snapshot AS s, ${cached?.ownXid ?? null}::xid8 AS own),
         r AS (SELECT pg_current_snapshot() AS s, pg_current_xact_id_if_assigned() AS own)
    SELECT r.s::text AS snapshot, r.own::text AS own_xid,
           EXISTS (
             SELECT 1 FROM entity_changes ec WHERE ec.xid = r.own AND ${filterSql(filter)}
           ) AS dirty,
           (c.s IS NOT NULL
            AND pg_snapshot_xmax(c.s) <= pg_snapshot_xmax(r.s)
            AND NOT EXISTS (
              SELECT 1 FROM pg_snapshot_xip(r.s) AS x(xid)
               WHERE x.xid < pg_snapshot_xmax(c.s) AND pg_visible_in_snapshot(x.xid, c.s)
            )
            AND NOT EXISTS (
              SELECT 1 FROM entity_changes ec
               WHERE (ec.xid >= pg_snapshot_xmin(c.s) OR ec.xid = c.own)
                 AND (NOT pg_visible_in_snapshot(ec.xid, c.s) OR ec.xid = c.own)
                 AND ${filterSql(filter)}
            )
            AND NOT EXISTS (
              SELECT 1 FROM entity_change_horizons h WHERE h.horizon >= pg_snapshot_xmin(c.s)
            )) AS fresh
      FROM c, r
  `)) as unknown as {
    snapshot: string;
    own_xid: string | null;
    dirty: boolean;
    fresh: boolean | null;
  }[];
  const row = rows[0];
  if (!row) throw new Error("checkJournalMark: the snapshot query returned no row");
  return {
    fresh: row.fresh === true,
    mark: { snapshot: row.snapshot, ownXid: row.own_xid, dirty: row.dirty },
  };
}

/** What a consumer read returned, plus the token that commits it. */
export interface ChangeBatch {
  readonly changes: readonly JournalChange[];
  /**
   * Pass to {@link commitChanges} once the batch is fully processed
   * (at-least-once: a crash before the commit re-delivers it).
   */
  readonly token: string;
  /** More rows of the same read are waiting: poll again after committing. */
  readonly more: boolean;
  /**
   * The cursor is below the GC horizon: rows may be lost. Run
   * {@link beginConsumerRebuild}, the consumer's rebuild-from-source, then
   * {@link finishConsumerRebuild}.
   */
  readonly needsRebuild: boolean;
}

interface ConsumerState {
  readonly cursor: string;
  readonly target: string | null;
  readonly afterXid: string | null;
  readonly afterTable: string | null;
  readonly afterRow: string | null;
}

interface Token {
  readonly v: 1;
  readonly name: string;
  readonly from: string;
  readonly cursor: string;
  readonly target: string | null;
  readonly after: readonly [string, string, string] | null;
}

/**
 * Create the consumer if it does not exist, with its cursor at "now" and
 * its rebuild pending: a consumer derives its initial state with its
 * rebuild, and changes from this moment on are delivered (registered
 * BEFORE the rebuild reads, so a change during the rebuild is delivered
 * once more rather than missed). Finish with {@link finishConsumerRebuild}.
 *
 * @returns whether the consumer was created by this call
 */
export async function registerConsumer(
  tx: TransactionRunner,
  name: string,
  pluginId: string | null = null,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    INSERT INTO change_consumers (name, plugin_id, cursor_snapshot)
    VALUES (${name}, ${pluginId}::uuid, pg_current_snapshot())
    ON CONFLICT (name) DO NOTHING
    RETURNING 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Start a rebuild: the cursor moves to "now" BEFORE the rebuild reads its
 * source, and the consumer is marked `rebuild_pending`. A change committed
 * while the rebuild runs is thus delivered after it (at least once), and a
 * rebuild that fails or is interrupted stays pending and runs again.
 */
export async function beginConsumerRebuild(tx: TransactionRunner, name: string): Promise<void> {
  const rows = (await tx.execute(sql`
    UPDATE change_consumers
       SET cursor_snapshot = pg_current_snapshot(), page_target = NULL, page_after_xid = NULL,
           page_after_table = NULL, page_after_row = NULL, rebuild_pending = true,
           updated_at = now()
     WHERE name = ${name}
    RETURNING 1
  `)) as unknown as unknown[];
  if (rows.length === 0) throw unknownConsumer(name);
}

/** The rebuild succeeded: the consumer reads the journal again. The cursor stays where the rebuild began. */
export async function finishConsumerRebuild(tx: TransactionRunner, name: string): Promise<void> {
  const rows = (await tx.execute(sql`
    UPDATE change_consumers SET rebuild_pending = false, updated_at = now()
     WHERE name = ${name}
    RETURNING 1
  `)) as unknown as unknown[];
  if (rows.length === 0) throw unknownConsumer(name);
}

/** Whether the consumer's derived state still has to be rebuilt ({@link beginConsumerRebuild}). */
export async function consumerRebuildPending(
  tx: TransactionRunner,
  name: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT rebuild_pending FROM change_consumers WHERE name = ${name}
  `)) as unknown as { rebuild_pending: boolean }[];
  const row = rows[0];
  if (!row) throw unknownConsumer(name);
  return row.rebuild_pending;
}

/** Remove consumers by name (a deactivated plugin's). */
export async function dropConsumers(tx: TransactionRunner, pluginId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    DELETE FROM change_consumers WHERE plugin_id = ${pluginId}::uuid RETURNING 1
  `)) as unknown as unknown[];
  return rows.length;
}

function unknownConsumer(name: string): Error {
  return new Error(
    `change consumer "${name}" is not registered — call registerConsumer (or the plugin's activation) before reading it`,
  );
}

async function loadConsumer(tx: TransactionRunner, name: string): Promise<ConsumerState> {
  const rows = (await tx.execute(sql`
    SELECT cursor_snapshot::text AS cursor, page_target::text AS target,
           page_after_xid::text AS after_xid, page_after_table AS after_table,
           page_after_row AS after_row
      FROM change_consumers WHERE name = ${name}
  `)) as unknown as {
    cursor: string;
    target: string | null;
    after_xid: string | null;
    after_table: string | null;
    after_row: string | null;
  }[];
  const row = rows[0];
  if (!row) throw unknownConsumer(name);
  return {
    cursor: row.cursor,
    target: row.target,
    afterXid: row.after_xid,
    afterTable: row.after_table,
    afterRow: row.after_row,
  };
}

interface RawChange {
  xid: string;
  table_name: string;
  row_id: string;
  kind: string;
  op: JournalChange["op"];
  changed_columns: string[] | null;
  parent_id: string | null;
  plugin_id: string | null;
  chat_branch_id: string | null;
  owner_chat_session_id: string | null;
  site_snapshot_id: string | null;
  prev_snapshot_id: string | null;
  op_name: string | null;
  created_at: string;
}

function toChange(r: RawChange): JournalChange {
  return {
    xid: r.xid,
    table: r.table_name,
    rowId: r.row_id,
    kind: r.kind,
    op: r.op,
    changedColumns: r.changed_columns,
    parentId: r.parent_id,
    pluginId: r.plugin_id,
    chatBranchId: r.chat_branch_id,
    ownerChatSessionId: r.owner_chat_session_id,
    siteSnapshotId: r.site_snapshot_id,
    prevSnapshotId: r.prev_snapshot_id,
    opName: r.op_name,
    createdAt: r.created_at,
  };
}

/**
 * Read journal rows between `cursor` and `target` (or now), after `after`.
 * The building block of {@link pollChanges}; also used by in-memory
 * consumers that keep their cursor in the process (the live fan-out).
 */
export async function readChanges(
  tx: TransactionRunner,
  input: {
    readonly cursor: string;
    readonly target: string | null;
    readonly after: readonly [string, string, string] | null;
    readonly filter: JournalFilter;
    readonly limit: number;
  },
): Promise<{
  changes: JournalChange[];
  target: string;
  needsRebuild: boolean;
  more: boolean;
}> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5000) {
    throw new Error("readChanges: limit must be an integer 1..5000");
  }
  const after = input.after;
  const rows = (await tx.execute(sql`
    WITH c AS (SELECT ${input.cursor}::pg_snapshot AS s,
                      COALESCE(${input.target}::pg_snapshot, pg_current_snapshot()) AS t),
    horizon AS (
      SELECT EXISTS (
        SELECT 1 FROM entity_change_horizons h, c WHERE h.horizon >= pg_snapshot_xmin(c.s)
      ) AS lost
    ),
    page AS (
      SELECT ec.xid AS sort_xid, ec.xid::text AS xid, ec.table_name, ec.row_id, ec.kind, ec.op, ec.changed_columns,
             ec.parent_id, ec.plugin_id::text AS plugin_id, ec.chat_branch_id::text AS chat_branch_id,
             ec.owner_chat_session_id::text AS owner_chat_session_id,
             ec.site_snapshot_id::text AS site_snapshot_id,
             ec.prev_snapshot_id::text AS prev_snapshot_id, ec.op_name,
             ec.created_at::text AS created_at
        FROM entity_changes ec, c
       WHERE ec.xid >= pg_snapshot_xmin(c.s)
         AND NOT pg_visible_in_snapshot(ec.xid, c.s)
         AND pg_visible_in_snapshot(ec.xid, c.t)
         ${
           after
             ? sql`AND (ec.xid, ec.table_name, ec.row_id) > (${after[0]}::xid8, ${after[1]}, ${after[2]})`
             : sql``
         }
         AND ${filterSql(input.filter)}
       ORDER BY ec.xid, ec.table_name, ec.row_id
       LIMIT ${input.limit + 1}
    )
    SELECT (SELECT t::text FROM c) AS target, (SELECT lost FROM horizon) AS lost, page.*
      FROM (SELECT 1) one LEFT JOIN page ON true
     ORDER BY page.sort_xid, page.table_name, page.row_id
  `)) as unknown as ({ target: string; lost: boolean } & (
    | RawChange
    | Record<keyof RawChange, null>
  ))[];
  const head = rows[0];
  if (!head) throw new Error("readChanges: the journal query returned no row");
  if (head.lost) return { changes: [], target: head.target, needsRebuild: true, more: false };
  const raw = rows.filter(
    (r): r is { target: string; lost: boolean } & RawChange => r.xid !== null,
  );
  const more = raw.length > input.limit;
  return {
    changes: raw.slice(0, input.limit).map(toChange),
    target: head.target,
    needsRebuild: false,
    more,
  };
}

/**
 * The next batch of a persisted consumer. Commit the returned token with
 * {@link commitChanges} after processing; poll again while `more`.
 */
export async function pollChanges(
  tx: TransactionRunner,
  name: string,
  input: { readonly filter: JournalFilter; readonly limit: number },
): Promise<ChangeBatch> {
  const state = await loadConsumer(tx, name);
  const after: [string, string, string] | null =
    state.afterXid !== null && state.afterTable !== null && state.afterRow !== null
      ? [state.afterXid, state.afterTable, state.afterRow]
      : null;
  const read = await readChanges(tx, {
    cursor: state.cursor,
    target: state.target,
    after,
    filter: input.filter,
    limit: input.limit,
  });
  const last = read.changes.at(-1);
  const token: Token = read.more
    ? {
        v: 1,
        name,
        from: state.cursor,
        cursor: state.cursor,
        target: read.target,
        after: last ? [last.xid, last.table, last.rowId] : after,
      }
    : { v: 1, name, from: state.cursor, cursor: read.target, target: null, after: null };
  return {
    changes: read.changes,
    token: JSON.stringify(token),
    more: read.more,
    needsRebuild: read.needsRebuild,
  };
}

/**
 * Store a polled batch as processed. Refuses a token of another consumer,
 * and one that no longer continues from the stored cursor (another
 * instance committed meanwhile — the claim was lost): the batch is then
 * re-delivered to whoever holds the claim.
 */
export async function commitChanges(
  tx: TransactionRunner,
  name: string,
  token: string,
): Promise<void> {
  let parsed: Token;
  try {
    parsed = JSON.parse(token) as Token;
  } catch {
    throw new Error(`commitChanges(${name}): the token is not one pollChanges returned`);
  }
  if (parsed.v !== 1 || parsed.name !== name) {
    throw new Error(`commitChanges(${name}): the token belongs to consumer "${parsed.name}"`);
  }
  const rows = (await tx.execute(sql`
    UPDATE change_consumers
       SET cursor_snapshot = ${parsed.cursor}::pg_snapshot,
           page_target = ${parsed.target}::pg_snapshot,
           page_after_xid = ${parsed.after?.[0] ?? null}::xid8,
           page_after_table = ${parsed.after?.[1] ?? null},
           page_after_row = ${parsed.after?.[2] ?? null},
           updated_at = now()
     WHERE name = ${name} AND cursor_snapshot::text = ${parsed.from}
    RETURNING 1
  `)) as unknown as unknown[];
  if (rows.length === 0) {
    throw new Error(
      `commitChanges(${name}): the cursor moved since this batch was polled — another instance consumed it; this instance no longer holds the claim`,
    );
  }
}

/**
 * Claim a consumer for this instance (rule 4: each consumer runs once per
 * site). Never waits: a claim another transaction is writing right now
 * counts as held. A claim expires on the database clock so a dead
 * instance's consumer is taken over.
 *
 * @param holder - a stable id of this process (e.g. its instance id)
 * @returns whether this instance holds the claim now
 */
export async function claimConsumer(
  tx: TransactionRunner,
  name: string,
  holder: string,
  leaseMs: number,
): Promise<boolean> {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000) {
    throw new Error("claimConsumer: leaseMs must be an integer >= 1000");
  }
  const rows = (await tx.execute(sql`
    WITH target AS (
      SELECT name FROM change_consumers
       WHERE name = ${name}
         AND (claimed_by IS NULL OR claimed_by = ${holder} OR claim_expires_at < now())
       FOR UPDATE SKIP LOCKED
    )
    UPDATE change_consumers c
       SET claimed_by = ${holder},
           claim_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
           updated_at = now()
      FROM target WHERE c.name = target.name
    RETURNING 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Give a claim back (an instance shutting down or a consumer deactivated). */
export async function releaseConsumer(
  tx: TransactionRunner,
  name: string,
  holder: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE change_consumers SET claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
     WHERE name = ${name} AND claimed_by = ${holder}
  `);
}

/** The current snapshot, as a cursor for an in-memory consumer. */
export async function currentJournalCursor(tx: TransactionRunner): Promise<string> {
  const rows = (await tx.execute(sql`SELECT pg_current_snapshot()::text AS s`)) as unknown as {
    s: string;
  }[];
  const s = rows[0]?.s;
  if (!s) throw new Error("currentJournalCursor: no snapshot returned");
  return s;
}

/** Default retention of journal rows (rule 4): GC never waits for a consumer. */
export const JOURNAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Delete journal rows older than `retentionMs` that belong to finished
 * transactions, at most `batch` per call, never waiting on a lock, and
 * record the newest deleted xid as a horizon. Must run as `system`.
 *
 * @returns how many rows were deleted
 */
export async function collectJournalGarbage(
  tx: TransactionRunner,
  opts: { readonly retentionMs?: number; readonly batch?: number } = {},
): Promise<number> {
  const retentionSecs = Math.floor((opts.retentionMs ?? JOURNAL_RETENTION_MS) / 1000);
  const batch = opts.batch ?? 10_000;
  const rows = (await tx.execute(sql`
    WITH victims AS (
      SELECT ec.xid, ec.table_name, ec.row_id FROM entity_changes ec
       WHERE ec.created_at < now() - make_interval(secs => ${retentionSecs})
         AND ec.xid < pg_snapshot_xmin(pg_current_snapshot())
       ORDER BY ec.xid
       LIMIT ${batch}
       FOR UPDATE SKIP LOCKED
    ),
    removed AS (
      DELETE FROM entity_changes ec USING victims v
       WHERE ec.xid = v.xid AND ec.table_name = v.table_name AND ec.row_id = v.row_id
      RETURNING ec.xid
    ),
    horizon AS (
      -- No max(xid8) aggregate before Postgres 16: order instead.
      INSERT INTO entity_change_horizons (gc_xid, horizon)
      SELECT pg_current_xact_id(), r.xid FROM removed r ORDER BY r.xid DESC LIMIT 1
      ON CONFLICT (gc_xid) DO UPDATE
        SET horizon = GREATEST(entity_change_horizons.horizon, EXCLUDED.horizon)
      RETURNING horizon
    )
    SELECT (SELECT count(*) FROM removed)::int AS deleted,
           (SELECT count(*) FROM horizon)::int AS recorded
  `)) as unknown as { deleted: number; recorded: number }[];
  // Only the newest horizon decides anything; older ones are dead weight.
  await tx.execute(sql`
    DELETE FROM entity_change_horizons
     WHERE horizon < (SELECT h.horizon FROM entity_change_horizons h ORDER BY h.horizon DESC LIMIT 1)
  `);
  return rows[0]?.deleted ?? 0;
}
