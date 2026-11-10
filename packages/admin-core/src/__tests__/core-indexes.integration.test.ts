// SPDX-License-Identifier: MPL-2.0

/**
 * #1291 — core queries on hot paths and growing tables are served by an
 * index (migrations 0460–0463).
 *
 * Each statement is planned twice under `SET LOCAL enable_seqscan = off`,
 * with its values and as a generic prepared plan (`$1 = col`, the shape
 * of Postgres's own FK checks and of a cached statement). In that mode
 * the planner takes any usable index even on an empty table, so a Seq
 * Scan left in the plan means no index can answer the predicate — which
 * is exactly the regression (a missing index, or a partial index whose
 * predicate the query does not carry).
 *
 *   - The three hot paths plan the exact statement production runs
 *     (exported builders): the quality record-result acceptance read (once
 *     per page per Stage), the MCP cost cap (every capped tool call) and
 *     the redirect chain collapse (every page move / slug change).
 *   - The reader shapes the audit found (audit window,
 *     step-up session, subagent run, chat-image GC, import page ref, chat
 *     takeovers, content instances by module) and the FK checks Postgres
 *     itself runs when a parent row is deleted.
 *   - Every FK whose parent production really deletes (chat sessions,
 *     roles, themes, domains, plugins, and everything their deletes
 *     cascade into) has an index the FK check can use — the catalog check
 *     fails on a new FK without one.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, type TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { rulesPointingAtSql } from "../ops/content/path-moves.js";
import { liveLighthouseAcceptancesSql } from "../ops/quality/record-result.js";
import { spentMicrocentsSql } from "../ops/security/mcp_tool_call.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "core-indexes-1291",
};
const ID = "00000000-0000-0000-0000-000000001291";

let adapter: DatabaseAdapter;

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
});

afterAll(async () => {
  await adapter.close();
});

const dialect = new PgDialect();

/** A SQL string literal (the test's parameters are ids and paths). */
function literal(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * The plans of `statement` with sequential scans disabled, as JSON text:
 * the custom plan (bound values, as one execution plans it) and the
 * generic plan (`$n` unknown, as a cached prepared statement — and
 * Postgres's own FK checks — plan it). A partial index must serve both.
 */
async function plansOf(statement: SQL): Promise<{ custom: string; generic: string }> {
  return adapter.withAdminTransaction(SYS, async (tx: TransactionRunner) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const explain = async (q: SQL) =>
      JSON.stringify((await tx.execute(sql`EXPLAIN (FORMAT JSON) ${q}`)) as unknown);
    const custom = await explain(statement);
    const { sql: text, params } = dialect.sqlToQuery(statement);
    await tx.execute(sql.raw(`PREPARE core_indexes_1291 AS ${text}`));
    await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
    const args = params.length > 0 ? `(${params.map(literal).join(", ")})` : "";
    const generic = await explain(sql.raw(`EXECUTE core_indexes_1291${args}`));
    // The plan really was the generic one, not a custom plan of the values.
    const [stats] = (await tx.execute(sql`
      SELECT generic_plans, custom_plans FROM pg_prepared_statements
       WHERE name = 'core_indexes_1291'
    `)) as unknown as { generic_plans: number | string; custom_plans: number | string }[];
    expect(Number(stats?.generic_plans)).toBe(1);
    expect(Number(stats?.custom_plans)).toBe(0);
    await tx.execute(sql`DEALLOCATE core_indexes_1291`);
    return { custom, generic };
  });
}

/** Relations the plan still reads by a sequential scan. */
function seqScanned(plan: string): string[] {
  return [...plan.matchAll(/"Node Type":"Seq Scan"[^}]*?"Relation Name":"(\w+)"/g)].map(
    (m) => m[1] as string,
  );
}

function expectIndexed(
  plans: { custom: string; generic: string },
  table: string,
  ...indexes: string[]
): void {
  for (const plan of [plans.custom, plans.generic]) {
    expect(seqScanned(plan)).not.toContain(table);
    for (const index of indexes) expect(plan).toContain(`"Index Name":"${index}"`);
  }
}

describe("#1291 — hot paths plan an index scan", () => {
  it("quality record-result reads a page's live acceptances by index", async () => {
    const plans = await plansOf(liveLighthouseAcceptancesSql(ID));
    expectIndexed(plans, "quality_acceptances", "quality_acceptances_page_kind_idx");
  });

  it("the MCP cost cap ORs two index lookups on ai_calls", async () => {
    const plans = await plansOf(spentMicrocentsSql(ID, ID, { mcpTokenId: ID }));
    expectIndexed(plans, "ai_calls", "ai_calls_chat_session_idx", "ai_calls_actor_idx");
  });

  it("a page move finds the rules to collapse by index, live and pending (#1550)", async () => {
    const plans = await plansOf(rulesPointingAtSql(["/a", "/c"]));
    expectIndexed(plans, "redirects", "redirects_to_path_idx");
    expectIndexed(plans, "pending_redirects", "pending_redirects_to_path_idx");
  });
});

/**
 * Statement shapes of the readers the audit found, copied from their
 * source (named per case), plus the lookups Postgres runs for an FK when
 * a parent row is deleted (`$1 = col`, which implies only `col IS NOT
 * NULL` — the reason a `deleted_at IS NULL` partial index never served).
 */
const READERS: ReadonlyArray<{ name: string; table: string; index: string; statement: SQL }> = [
  {
    name: "audit_events.aggregate_by_op_prefix window (ops/security/ai_calls_by_op.ts)",
    table: "audit_events",
    index: "audit_events_created_at_idx",
    statement: sql`SELECT count(*) FROM audit_events WHERE created_at >= now() - interval '30 days' AND operation LIKE '%.%'`,
  },
  {
    name: "step-up session lookup (ops/step-up.ts, security/step-up/gate.ts)",
    table: "sessions",
    index: "sessions_user_id_idx",
    statement: sql`SELECT step_up_at FROM sessions
      WHERE encode(sha256(convert_to(token, 'UTF8')), 'hex') = ${"x"} AND user_id = ${ID}::uuid`,
  },
  {
    name: "subagent run of a subagent session (ops/imports.ts)",
    table: "subagent_runs",
    index: "subagent_runs_subagent_session_idx",
    statement: sql`SELECT id FROM subagent_runs WHERE subagent_chat_session_id = ${ID}::uuid`,
  },
  {
    name: "chat-image GC (chat-image-gc-worker.ts)",
    table: "chat_messages",
    index: "chat_messages_with_attachments_idx",
    statement: sql`SELECT m.id FROM chat_messages m, LATERAL jsonb_array_elements(m.attachments::jsonb) a
      WHERE m.attachments IS NOT NULL AND a ? 'storageKey'`,
  },
  {
    name: "resolveImportPageRef (ops/imports.ts)",
    table: "import_pages",
    index: "import_pages_accepted_page_idx",
    statement: sql`SELECT id FROM import_pages WHERE id = ${ID}::uuid OR accepted_page_id = ${ID}::uuid`,
  },
  {
    name: "a chat's lock takeovers (ops/chat/open-changes.ts)",
    table: "chat_lock_takeovers",
    index: "chat_lock_takeovers_from_session_idx",
    statement: sql`SELECT id FROM chat_lock_takeovers
      WHERE to_chat_session_id = ${ID}::uuid OR from_chat_session_id = ${ID}::uuid`,
  },
  {
    name: "content instances of a module set, deleted included (lists/local.ts)",
    table: "content_instances",
    index: "content_instances_module_id_idx",
    statement: sql`SELECT id FROM content_instances
      WHERE chat_branch_id IS NULL AND module_id = ANY(ARRAY[${ID}::uuid])`,
  },
  {
    name: "FK check of a page delete on pages.parent_page_id",
    table: "pages",
    index: "pages_parent_page_id_idx",
    statement: sql`SELECT 1 FROM ONLY pages x WHERE ${ID}::uuid = parent_page_id FOR KEY SHARE OF x`,
  },
  {
    name: "FK check of a chat-session delete on ai_calls.parent_chat_session_id",
    table: "ai_calls",
    index: "ai_calls_parent_chat_session_id_idx",
    statement: sql`SELECT 1 FROM ONLY ai_calls x WHERE ${ID}::uuid = parent_chat_session_id FOR KEY SHARE OF x`,
  },
];

describe("#1291 — readers and FK checks plan an index scan", () => {
  for (const r of READERS) {
    it(r.name, async () => {
      expectIndexed(await plansOf(r.statement), r.table, r.index);
    });
  }
});

/**
 * Tables production hard-deletes rows of: the subagent session GC
 * (`subagent_runs.gc_old_sessions`), `roles.delete`, an approved theme
 * deletion, `domains.remove`, plugin uninstall. Everything their deletes
 * cascade into is added by the query below.
 */
const DELETED_ROOTS = ["chat_sessions", "roles", "themes", "domains", "plugins"] as const;

describe("#1291 — FKs to deleted parents have a usable index", () => {
  it("every referencing column leads a plain or IS NOT NULL index", async () => {
    const missing = await adapter.withAdminTransaction(SYS, async (tx: TransactionRunner) => {
      // A partial index serves the FK check `$1 = col` only when its
      // predicate is `col IS NOT NULL` (implied by the strict `=`).
      const rows = (await tx.execute(sql`
        WITH RECURSIVE deleted(rel) AS (
          SELECT unnest(${`{${DELETED_ROOTS.join(",")}}`}::regclass[])
          UNION
          SELECT c.conrelid FROM pg_constraint c JOIN deleted d ON c.confrelid = d.rel
           WHERE c.contype = 'f' AND c.confdeltype = 'c'
        )
        SELECT c.conrelid::regclass::text AS tbl,
               c.confrelid::regclass::text AS ref,
               (SELECT string_agg(a.attname, ',' ORDER BY k.n)
                  FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
          FROM pg_constraint c
         WHERE c.contype = 'f' AND c.confrelid IN (SELECT rel FROM deleted)
           AND NOT EXISTS (
             SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid
                AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
                AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
                AND (i.indpred IS NULL
                     OR (cardinality(c.conkey) = 1
                         AND pg_get_expr(i.indpred, i.indrelid) =
                             '(' || (SELECT attname FROM pg_attribute
                                      WHERE attrelid = c.conrelid AND attnum = c.conkey[1])
                                 || ' IS NOT NULL)')))
         ORDER BY 2, 1
      `)) as unknown as { tbl: string; ref: string; cols: string }[];
      return rows.map((r) => `${r.tbl}(${r.cols}) -> ${r.ref}`);
    });
    expect(missing).toEqual([]);
  });
});
