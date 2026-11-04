// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1269 — exact usage counts, counted by Postgres: pages per page
 * type and lists per list type, as the caller's branch sees them.
 *
 * One statement each, returning one row per type: the stored rows the
 * branch has no pending state for are counted as stored, every pending
 * state of the kind is counted as it now stands (a page a chat retyped or
 * deleted counts where the chat left it). The cost is the counted rows
 * plus the branch's pending states of the kind — never shipped to the
 * process. Exact by decision (2026-11-04): the ops count only when the
 * caller asks (`counts: true`, the admin pages and the AI's list tools),
 * so render hooks and plugins never pay for it.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import { headOverlaySql } from "../draft.js";

async function countByType(
  tx: TransactionRunner,
  spec: {
    readonly table: "pages" | "lists";
    readonly typeColumn: "page_type_id" | "list_type_id";
    readonly kind: "page" | "list";
    readonly snapshotTable: "page_snapshots" | "list_snapshots";
    readonly stateTypeKey: "pageTypeId" | "listTypeId";
  },
  branchId: string | null,
): Promise<Map<string, number>> {
  const visible: SQL = branchId
    ? sql`(r.chat_branch_id IS NULL OR r.chat_branch_id = ${branchId}::uuid)`
    : sql`r.chat_branch_id IS NULL`;
  const table = sql.raw(spec.table);
  const typeColumn = sql.raw(spec.typeColumn);
  const rows = (await tx.execute(
    branchId
      ? sql`
        WITH h AS (${headOverlaySql({
          kind: spec.kind,
          table: spec.snapshotTable,
          branchId,
          columns: sql`es.state->>${spec.stateTypeKey} AS type_id,
                       (es.state->>'deletedAt') IS NOT NULL AS deleted`,
        })})
        SELECT type_id, count(*)::int AS n FROM (
          SELECT r.${typeColumn}::text AS type_id FROM ${table} r
           WHERE r.deleted_at IS NULL AND ${visible}
             AND NOT EXISTS (SELECT 1 FROM h WHERE h.entity_id = r.id::text)
          UNION ALL
          SELECT h.type_id FROM h WHERE NOT h.deleted
        ) x
        WHERE type_id IS NOT NULL
        GROUP BY type_id`
      : sql`
        SELECT r.${typeColumn}::text AS type_id, count(*)::int AS n
          FROM ${table} r
         WHERE r.deleted_at IS NULL AND ${visible} AND r.${typeColumn} IS NOT NULL
         GROUP BY r.${typeColumn}`,
  )) as unknown as { type_id: string; n: number }[];
  return new Map(rows.map((r) => [r.type_id, r.n]));
}

/** Pages per page type id in the caller's view (types without pages are absent). */
export function countPagesByType(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<Map<string, number>> {
  return countByType(
    tx,
    {
      table: "pages",
      typeColumn: "page_type_id",
      kind: "page",
      snapshotTable: "page_snapshots",
      stateTypeKey: "pageTypeId",
    },
    branchId,
  );
}

/** Lists per list type id in the caller's view (types without lists are absent). */
export function countListsByType(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<Map<string, number>> {
  return countByType(
    tx,
    {
      table: "lists",
      typeColumn: "list_type_id",
      kind: "list",
      snapshotTable: "list_snapshots",
      stateTypeKey: "listTypeId",
    },
    branchId,
  );
}
