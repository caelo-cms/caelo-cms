// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — lock TAKEOVER instead of a blocking lock.
 *
 * Before #620 a chat writing an entity another chat held got a `Locked`
 * error, and a forgotten chat could block every other chat indefinitely.
 * Now the writing chat ADOPTS the holder's unstaged change on that entity:
 *
 *   - every branch snapshot the holder wrote for the entity since its last
 *     Stage moves to the writer's branch (re-pointed under new
 *     `chat.adopt_change` headers, oldest first, so "latest snapshot wins"
 *     still picks the newest state);
 *   - rows the holder CREATED on its branch that the adopted state points
 *     at (a new module placed on an adopted page, a new content instance,
 *     a new template) move with it — otherwise the writer's branch would
 *     reference rows it cannot see and its Stage would ship dangling ids;
 *   - the lock moves to the writer.
 *
 * The write that triggered the takeover then runs inside the same
 * transaction and reads the adopted state through the normal branch
 * overlay, so it builds on the holder's change instead of overwriting it.
 * Nothing is lost (the change now ships with the adopting chat) and
 * nothing is silently overwritten. Each takeover is recorded in
 * `chat_lock_takeovers`; tool dispatch turns that row into a visible note
 * for BOTH chats (see {@link drainTakeoverNotices}).
 *
 * There is deliberately no time-based lock expiry: an expired lock over
 * unstaged changes would let two branches edit the same entity, and the
 * next Stage would silently overwrite one of them.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import type { LockedEntityKind } from "./locks.js";

/** One snapshot table + the column that names the entity in it. */
interface SnapshotTable {
  readonly table: string;
  readonly column: string;
  /** `chat_branch_publish_marks.entity_kind` for rows of this table. */
  readonly markKind: string;
  /** Column holding the mark's entity id (differs for per-placement content). */
  readonly markColumn: string;
}

/**
 * Snapshot tables per lock kind. Kinds absent here (layout, redirect,
 * siteSettings, siteDefaults) write the live tables directly — their
 * holder has nothing on its branch to adopt, only the lock moves.
 */
const SNAPSHOT_TABLES: Partial<Record<LockedEntityKind, readonly SnapshotTable[]>> = {
  module: [
    { table: "module_snapshots", column: "module_id", markKind: "module", markColumn: "module_id" },
  ],
  template: [
    {
      table: "template_snapshots",
      column: "template_id",
      markKind: "template",
      markColumn: "template_id",
    },
  ],
  // A page lock covers the page row, its placements and its per-placement
  // content: every page-bound write takes the `page` lock.
  page: [
    { table: "page_snapshots", column: "page_id", markKind: "page", markColumn: "page_id" },
    {
      table: "page_layout_snapshots",
      column: "page_id",
      markKind: "pageLayout",
      markColumn: "page_id",
    },
    {
      table: "page_module_content_snapshots",
      column: "page_id",
      markKind: "pageModuleContent",
      markColumn: "page_module_content_id",
    },
  ],
  pageLayout: [
    {
      table: "page_layout_snapshots",
      column: "page_id",
      markKind: "pageLayout",
      markColumn: "page_id",
    },
  ],
  structuredSet: [
    {
      table: "structured_set_snapshots",
      column: "structured_set_id",
      markKind: "structuredSet",
      markColumn: "structured_set_id",
    },
  ],
  contentInstance: [
    {
      table: "content_instance_snapshots",
      column: "content_instance_id",
      markKind: "contentInstance",
      markColumn: "content_instance_id",
    },
  ],
  theme: [
    { table: "theme_snapshots", column: "theme_id", markKind: "theme", markColumn: "theme_id" },
  ],
  pluginRow: [
    {
      table: "plugin_row_snapshots",
      column: "row_id",
      markKind: "pluginRow",
      markColumn: "row_id",
    },
  ],
};

/** Live tables whose rows can be created on a chat branch (migrations 0089, 0093). */
const BRANCH_CREATED_TABLE: Partial<Record<LockedEntityKind, string>> = {
  module: "modules",
  template: "templates",
  page: "pages",
  contentInstance: "content_instances",
};

/** The two chats of a takeover. */
export interface TakeoverParty {
  readonly chatSessionId: string;
  readonly chatBranchId: string;
}

/** What a takeover did — echoed into the lock check result. */
export interface TakeoverOutcome {
  readonly fromChatSessionId: string;
  readonly fromChatTitle: string;
  readonly label: string;
  /** Entity snapshots moved from the holder's branch (0 = only the lock moved). */
  readonly adoptedSnapshotCount: number;
}

interface SessionInfo {
  readonly title: string;
  readonly createdBy: string;
  readonly lastStagedAt: string | null;
}

interface MovedRow {
  readonly table: string;
  readonly id: string;
  readonly originalHeaderId: string;
  readonly createdAt: string;
  readonly opKind: string;
}

async function loadSession(tx: TransactionRunner, chatSessionId: string): Promise<SessionInfo> {
  const rows = (await tx.execute(sql`
    SELECT title, created_by::text AS created_by,
           to_char(last_staged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_staged_at
    FROM chat_sessions WHERE id = ${chatSessionId}::uuid
  `)) as unknown as { title: string; created_by: string; last_staged_at: string | null }[];
  const row = rows[0];
  if (!row) {
    // The lock row references the session with ON DELETE CASCADE, so a
    // missing session here means the caller passed a wrong id — fail loud.
    throw new Error(`lock takeover: chat session ${chatSessionId} not found`);
  }
  return { title: row.title, createdBy: row.created_by, lastStagedAt: row.last_staged_at };
}

function sinceFilter(lastStagedAt: string | null): SQL {
  return lastStagedAt === null ? sql`` : sql` AND ss.created_at > ${lastStagedAt}::timestamptz`;
}

/**
 * Ids a snapshot state points at that may be rows the holder created on
 * its branch. Only the shapes that carry references are inspected.
 */
function referencedEntities(
  kind: LockedEntityKind,
  table: string,
  state: unknown,
): { kind: LockedEntityKind; id: string }[] {
  if (!state || typeof state !== "object") return [];
  const s = state as Record<string, unknown>;
  const out: { kind: LockedEntityKind; id: string }[] = [];
  if (table === "page_layout_snapshots" && Array.isArray(s.blocks)) {
    for (const block of s.blocks as Record<string, unknown>[]) {
      for (const id of Array.isArray(block.moduleIds) ? block.moduleIds : []) {
        if (typeof id === "string") out.push({ kind: "module", id });
      }
      for (const p of Array.isArray(block.placements) ? block.placements : []) {
        const placement = p as Record<string, unknown>;
        if (typeof placement.moduleId === "string") {
          out.push({ kind: "module", id: placement.moduleId });
        }
        if (typeof placement.contentInstanceId === "string") {
          out.push({ kind: "contentInstance", id: placement.contentInstanceId });
        }
      }
    }
  } else if (table === "page_snapshots" && typeof s.templateId === "string") {
    out.push({ kind: "template", id: s.templateId });
  } else if (kind === "contentInstance" && typeof s.moduleId === "string") {
    out.push({ kind: "module", id: s.moduleId });
  }
  return out;
}

/** True iff the live row exists and was created on `branchId` (not yet merged). */
async function createdOnBranch(
  tx: TransactionRunner,
  kind: LockedEntityKind,
  id: string,
  branchId: string,
): Promise<boolean> {
  const table = BRANCH_CREATED_TABLE[kind];
  if (!table) return false;
  const rows = (await tx.execute(sql`
    SELECT 1 FROM ${sql.raw(table)}
    WHERE id = ${id}::uuid AND chat_branch_id = ${branchId}::uuid
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Human label of a locked entity (slug / title / name), falling back to the id. */
export async function lockedEntityLabel(
  tx: TransactionRunner,
  kind: LockedEntityKind,
  entityId: string,
): Promise<string> {
  const lookup: Partial<Record<LockedEntityKind, SQL>> = {
    module: sql`SELECT COALESCE(display_name, slug) AS label FROM modules WHERE id = ${entityId}::uuid`,
    template: sql`SELECT COALESCE(display_name, slug) AS label FROM templates WHERE id = ${entityId}::uuid`,
    page: sql`SELECT COALESCE(title, slug) AS label FROM pages WHERE id = ${entityId}::uuid`,
    pageLayout: sql`SELECT COALESCE(title, slug) AS label FROM pages WHERE id = ${entityId}::uuid`,
    layout: sql`SELECT display_name AS label FROM layouts WHERE id = ${entityId}::uuid`,
    structuredSet: sql`SELECT display_name AS label FROM structured_sets WHERE id = ${entityId}::uuid`,
    theme: sql`SELECT display_name AS label FROM themes WHERE id = ${entityId}::uuid`,
    contentInstance: sql`
      SELECT COALESCE(ci.display_name, ci.slug, m.slug) AS label
      FROM content_instances ci LEFT JOIN modules m ON m.id = ci.module_id
      WHERE ci.id = ${entityId}::uuid`,
    redirect: sql`SELECT from_path AS label FROM redirects WHERE id = ${entityId}::uuid`,
  };
  const query = lookup[kind];
  if (!query) return `${kind} ${entityId}`;
  const rows = (await tx.execute(query)) as unknown as { label: string | null }[];
  return rows[0]?.label ?? `${kind} ${entityId}`;
}

/**
 * Move the holder's unstaged change on (kind, entityId) — plus the rows it
 * created that the change references — to the taker's branch, move the
 * locks with it, and record the takeover. Must run inside the write's
 * transaction, after the caller locked the `chat_entity_locks` row. The
 * new snapshot headers are attributed to the adopting chat's owner.
 *
 * @returns what was adopted, for the lock-check result and the notices.
 */
export async function takeOverEntity(
  tx: TransactionRunner,
  args: {
    readonly kind: LockedEntityKind;
    readonly entityId: string;
    readonly holder: TakeoverParty;
    readonly taker: TakeoverParty;
  },
): Promise<TakeoverOutcome> {
  const { holder, taker } = args;
  const holderInfo = await loadSession(tx, holder.chatSessionId);
  const takerInfo = await loadSession(tx, taker.chatSessionId);
  const since = sinceFilter(holderInfo.lastStagedAt);

  // Worklist: the requested entity, then every holder-created row the
  // adopted states reference (transitively).
  const queue: { kind: LockedEntityKind; id: string; retag: boolean }[] = [
    { kind: args.kind, id: args.entityId, retag: false },
  ];
  const seen = new Set<string>([`${args.kind}:${args.entityId}`]);
  const moved: MovedRow[] = [];
  const marks: { kind: string; id: string }[] = [];
  const units: { kind: LockedEntityKind; id: string }[] = [];

  while (queue.length > 0) {
    const unit = queue.shift();
    if (!unit) break;
    units.push({ kind: unit.kind, id: unit.id });
    if (unit.retag) {
      const table = BRANCH_CREATED_TABLE[unit.kind];
      if (table) {
        await tx.execute(sql`
          UPDATE ${sql.raw(table)} SET chat_branch_id = ${taker.chatBranchId}::uuid
          WHERE id = ${unit.id}::uuid AND chat_branch_id = ${holder.chatBranchId}::uuid
        `);
      }
    }
    for (const t of SNAPSHOT_TABLES[unit.kind] ?? []) {
      const rows = (await tx.execute(sql`
        SELECT es.id::text AS id,
               es.${sql.raw(t.markColumn)}::text AS mark_id,
               es.state,
               ss.id::text AS header_id,
               ss.op_kind,
               to_char(ss.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM ${sql.raw(t.table)} es
        JOIN site_snapshots ss ON ss.id = es.site_snapshot_id
        WHERE ss.chat_branch_id = ${holder.chatBranchId}::uuid
          AND es.${sql.raw(t.column)} = ${unit.id}::uuid${since}
        ORDER BY ss.created_at, es.created_at, es.id
        FOR UPDATE OF es
      `)) as unknown as {
        id: string;
        mark_id: string;
        state: unknown;
        header_id: string;
        op_kind: string;
        created_at: string;
      }[];
      for (const r of rows) {
        moved.push({
          table: t.table,
          id: r.id,
          originalHeaderId: r.header_id,
          createdAt: r.created_at,
          opKind: r.op_kind,
        });
        marks.push({ kind: t.markKind, id: r.mark_id });
        const state = typeof r.state === "string" ? JSON.parse(r.state) : r.state;
        for (const ref of referencedEntities(unit.kind, t.table, state)) {
          const key = `${ref.kind}:${ref.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (await createdOnBranch(tx, ref.kind, ref.id, holder.chatBranchId)) {
            queue.push({ kind: ref.kind, id: ref.id, retag: true });
          }
        }
      }
    }
  }

  // Re-point the moved rows under new headers on the taker's branch: one
  // header per original header (rows one write produced stay together),
  // in the original order, spaced one microsecond apart BEFORE now() so
  // the triggering write (stamped now()) stays the newest state.
  const headers = new Map<string, MovedRow[]>();
  for (const row of moved) {
    const group = headers.get(row.originalHeaderId);
    if (group) group.push(row);
    else headers.set(row.originalHeaderId, [row]);
  }
  const ordered = [...headers.values()].sort((a, b) =>
    (a[0]?.createdAt ?? "").localeCompare(b[0]?.createdAt ?? ""),
  );
  const label = await lockedEntityLabel(tx, args.kind, args.entityId);
  const description = `chat.adopt_change ${args.kind} '${label}' from chat '${holderInfo.title}' (${holder.chatSessionId})`;
  for (const [i, group] of ordered.entries()) {
    const offsetMicros = ordered.length - i;
    const inserted = (await tx.execute(sql`
      INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id, created_at)
      VALUES (
        ${takerInfo.createdBy}::uuid, 'chat.adopt_change', ${description},
        ${taker.chatSessionId}::uuid, ${taker.chatBranchId}::uuid,
        now() - make_interval(secs => ${offsetMicros}::double precision / 1000000)
      )
      RETURNING id::text AS id,
                (created_at > COALESCE(${takerInfo.lastStagedAt}::timestamptz, '-infinity'::timestamptz)) AS after_stage
    `)) as unknown as { id: string; after_stage: boolean }[];
    const header = inserted[0];
    if (!header?.after_stage) {
      // The taker staged within the last few microseconds of this
      // transaction's start — the adopted rows would fall behind its
      // pending window and vanish from its next Stage. Fail loud; the
      // write is retried by the caller.
      throw new Error(
        "lock takeover: the adopting chat was staged at this very moment — retry the write",
      );
    }
    for (const row of group) {
      await tx.execute(sql`
        UPDATE ${sql.raw(row.table)} SET site_snapshot_id = ${header.id}::uuid
        WHERE id = ${row.id}::uuid
      `);
    }
  }

  // The holder's stage marks for the moved entities would otherwise point
  // at snapshots it no longer owns.
  for (const m of marks) {
    await tx.execute(sql`
      DELETE FROM chat_branch_publish_marks
      WHERE chat_branch_id = ${holder.chatBranchId}::uuid
        AND entity_kind = ${m.kind} AND entity_id = ${m.id}::uuid
    `);
  }

  // Locks + sibling leases follow the adopted entities. The requested
  // entity's lock row exists (the caller read it FOR UPDATE); referenced
  // rows' locks exist when the holder wrote them after creating them.
  for (const u of units) {
    await tx.execute(sql`
      UPDATE chat_entity_locks
      SET chat_session_id = ${taker.chatSessionId}::uuid,
          chat_branch_id = ${taker.chatBranchId}::uuid,
          locked_at = now()
      WHERE entity_kind = ${u.kind} AND entity_id = ${u.id}::uuid
        AND chat_session_id = ${holder.chatSessionId}::uuid
    `);
    await tx.execute(sql`
      DELETE FROM entity_leases
      WHERE entity_kind = ${u.kind} AND entity_id = ${u.id}::uuid
        AND branch_id = ${holder.chatBranchId}::uuid
    `);
  }

  await tx.execute(sql`
    INSERT INTO chat_lock_takeovers
      (entity_kind, entity_id, label, from_chat_session_id, from_chat_title,
       to_chat_session_id, to_chat_title, adopted_snapshot_count, actor_id)
    VALUES (
      ${args.kind}, ${args.entityId}::uuid, ${label},
      ${holder.chatSessionId}::uuid, ${holderInfo.title},
      ${taker.chatSessionId}::uuid, ${takerInfo.title},
      ${moved.length}, ${takerInfo.createdBy}::uuid
    )
  `);

  return {
    fromChatSessionId: holder.chatSessionId,
    fromChatTitle: holderInfo.title,
    label,
    adoptedSnapshotCount: moved.length,
  };
}

/**
 * Takeover notes not yet shown to `chatSessionId`, marked delivered.
 * Covers both sides: entities this chat adopted, and entities another chat
 * adopted FROM this chat. Tool dispatch appends the lines to the next tool
 * result so the AI tells the operator — the "visible" half of a takeover.
 */
export async function drainTakeoverNotices(
  tx: TransactionRunner,
  chatSessionId: string,
): Promise<string[]> {
  const adopted = (await tx.execute(sql`
    UPDATE chat_lock_takeovers SET to_notified_at = now()
    WHERE to_chat_session_id = ${chatSessionId}::uuid AND to_notified_at IS NULL
    RETURNING entity_kind, label, from_chat_title, adopted_snapshot_count, created_at
  `)) as unknown as {
    entity_kind: string;
    label: string;
    from_chat_title: string;
    adopted_snapshot_count: number;
    created_at: string | Date;
  }[];
  const lost = (await tx.execute(sql`
    UPDATE chat_lock_takeovers SET from_notified_at = now()
    WHERE from_chat_session_id = ${chatSessionId}::uuid AND from_notified_at IS NULL
    RETURNING entity_kind, label, to_chat_title, adopted_snapshot_count, created_at
  `)) as unknown as {
    entity_kind: string;
    label: string;
    to_chat_title: string;
    adopted_snapshot_count: number;
    created_at: string | Date;
  }[];
  const notes: string[] = [];
  for (const a of adopted) {
    notes.push(
      a.adopted_snapshot_count > 0
        ? `Change from chat '${a.from_chat_title}' adopted into this chat: its unstaged edit of ${a.entity_kind} '${a.label}' is now part of this chat and ships when this chat is staged (nothing was lost; your edit built on it). Tell the operator.`
        : `${a.entity_kind} '${a.label}' was held by chat '${a.from_chat_title}' without unstaged changes; this chat took it over.`,
    );
  }
  for (const l of lost) {
    if (l.adopted_snapshot_count === 0) continue;
    notes.push(
      `Chat '${l.to_chat_title}' took over ${l.entity_kind} '${l.label}': this chat's unstaged edit of it now ships with that chat, not this one (nothing was lost). Re-read it before changing it again. Tell the operator.`,
    );
  }
  return notes;
}
