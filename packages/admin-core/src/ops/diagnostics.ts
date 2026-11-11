// SPDX-License-Identifier: MPL-2.0

/**
 * `diagnostics.database_activity` — the database's own session list at one
 * moment, for the incident capture's bug report (#1595).
 *
 * Reads `pg_stat_activity` (state, wait event, how long the transaction and
 * the statement are open, who blocks the session) and the database's
 * deadlock count. admin_role sees the statement text of its own sessions on
 * every admin instance, which is what tells a lock queue from an idle
 * transaction from a CPU-starved database; other roles' sessions appear with
 * their state only. Statement text is stripped of literals before it leaves
 * the op (`sanitizeStatement`), and no parameter is ever part of it: Bun
 * sends every value as a bound parameter.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { sanitizeStatement } from "../incident/evidence.js";

/** Sessions the snapshot lists at most (a server holds ~100 connections). */
const MAX_SESSIONS = 200;

const sessionSchema = z.object({
  pid: z.number().int(),
  database: z.string().nullable(),
  role: z.string().nullable(),
  state: z.string().nullable(),
  waitEventType: z.string().nullable(),
  waitEvent: z.string().nullable(),
  xactMs: z.number().nullable(),
  queryMs: z.number().nullable(),
  stateMs: z.number().nullable(),
  blockedBy: z.array(z.number().int()),
  statement: z.string().nullable(),
});

interface SessionRow {
  pid: number;
  database: string | null;
  role: string | null;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  xact_ms: string | number | null;
  query_ms: string | number | null;
  state_ms: string | number | null;
  blocked_by: string;
  query: string | null;
}

const num = (v: string | number | null): number | null =>
  v === null ? null : Math.round(Number(v));

export const databaseActivityOp = defineOperation({
  name: "diagnostics.database_activity",
  readScope: "request",
  // Why system-only: the session list shows the statements every admin
  // instance runs; it is evidence for an automatic bug report, not
  // something an editor or the AI acts on.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    takenAt: z.string(),
    sessions: z.array(sessionSchema),
    deadlocks: z.number().int(),
  }),
  handler: async (_ctx, _input, tx) => {
    // A snapshot taken during a stall must not become part of it.
    await tx.execute(sql`SELECT set_config('statement_timeout', '5s', true)`);
    const rows = (await tx.execute(sql`
      SELECT pid,
             datname AS database,
             usename AS role,
             state,
             wait_event_type,
             wait_event,
             EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000 AS xact_ms,
             EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000 AS query_ms,
             EXTRACT(EPOCH FROM (clock_timestamp() - state_change)) * 1000 AS state_ms,
             array_to_string(pg_blocking_pids(pid), ',') AS blocked_by,
             left(query, 2000) AS query
      FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
      ORDER BY xact_start NULLS LAST, pid
      LIMIT ${MAX_SESSIONS}
    `)) as unknown as SessionRow[];
    const stats = (await tx.execute(sql`
      SELECT clock_timestamp()::text AS taken_at,
             COALESCE((SELECT deadlocks FROM pg_stat_database
                       WHERE datname = current_database()), 0)::int AS deadlocks
    `)) as unknown as { taken_at: string; deadlocks: number }[];
    return ok({
      takenAt: stats[0]?.taken_at ?? new Date().toISOString(),
      deadlocks: Number(stats[0]?.deadlocks ?? 0),
      sessions: rows.map((r) => ({
        pid: Number(r.pid),
        database: r.database,
        role: r.role,
        state: r.state,
        waitEventType: r.wait_event_type,
        waitEvent: r.wait_event,
        xactMs: num(r.xact_ms),
        queryMs: num(r.query_ms),
        stateMs: num(r.state_ms),
        blockedBy:
          r.blocked_by === "" ? [] : r.blocked_by.split(",").map((pid) => Number(pid.trim())),
        statement: sanitizeStatement(r.query),
      })),
    });
  },
});
