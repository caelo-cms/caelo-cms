// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1749 — what the cms_admin triggers cost every database connection.
 *
 * PL/pgSQL compiles a trigger function once per TRIGGER and keeps each
 * copy, with a cached plan for every expression it ran, for the life of
 * the connection. The journal trigger is attached four times to every
 * journaled table (276 triggers on searchVIU), so a fat body is paid
 * hundreds of times per connection: before migration 0885 a connection
 * that had written to every table held about 50 MB for the journal alone,
 * and 22 such connections swapped a db-f1-micro until every statement
 * timed out.
 *
 * These tests measure one connection's own memory contexts
 * (`pg_backend_memory_contexts`, superuser) before and after triggers
 * fire, inside a transaction that is rolled back:
 *
 * - a journaled table: scratch tables with the journal attached, each
 *   written (insert, update, delete), so every copy runs its whole path;
 * - every trigger of the migrated schema, fired by statements that match
 *   nothing (and an UPDATE of one row where a table has one), so a new
 *   trigger function with a fat body fails here, not on a production
 *   server.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const env = process.env;
const required = ["POSTGRES_USER", "POSTGRES_PORT"] as const;
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) throw new Error(`${missing.join(", ")} required (see .env.example)`);

const superuserUrl = (db: string) => {
  const u = new URL(`postgres://localhost/${db}`);
  u.hostname = env.PGHOST ?? "localhost";
  u.port = env.POSTGRES_PORT as string;
  u.username = env.POSTGRES_USER as string;
  if (env.POSTGRES_PASSWORD) u.password = env.POSTGRES_PASSWORD;
  return u.toString();
};

/**
 * The most one journal trigger copy may cost a connection: its compiled
 * body plus the plans of the expressions it ran. 0885 brought it from
 * about 270 kB to about 60 kB.
 */
const JOURNAL_COPY_BUDGET_BYTES = 96 * 1024;

/**
 * The most one trigger of the schema may cost a connection on average,
 * fired once. Before 0885 the schema averaged about 150 kB, after it
 * about 60 kB.
 */
const SCHEMA_TRIGGER_BUDGET_BYTES = 96 * 1024;

/** Scratch tables of the journal test: enough copies to see past noise. */
const SCRATCH_TABLES = 12;

/** The contexts a trigger copy leaves behind (body and expression plans). */
const TRIGGER_CONTEXTS = `name IN ('PL/pgSQL function', 'CachedPlanSource', 'CachedPlanQuery', 'CachedPlan', 'SPI Plan')`;

type Tx = Parameters<Parameters<SQL["begin"]>[0]>[0];

async function triggerBytes(tx: Tx): Promise<number> {
  const [row] = (await tx.unsafe(
    `SELECT COALESCE(sum(total_bytes), 0)::bigint AS bytes FROM pg_backend_memory_contexts WHERE ${TRIGGER_CONTEXTS}`,
  )) as { bytes: string | number }[];
  return Number(row?.bytes ?? 0);
}

async function compiledCopies(tx: Tx, fn: string): Promise<number> {
  const [row] = (await tx.unsafe(
    `SELECT count(*)::int AS n FROM pg_backend_memory_contexts WHERE name = 'PL/pgSQL function' AND ident = $1`,
    [`${fn}()`],
  )) as { n: number }[];
  return row?.n ?? 0;
}

/** Create a scratch table with the journal attached, and write one row of it. */
async function writeJournaledScratch(tx: Tx, i: number): Promise<void> {
  const table = `caelo_trigger_memory_${i}`;
  await tx.unsafe(
    `CREATE TABLE ${table} (id uuid PRIMARY KEY, v text NOT NULL, chat_branch_id uuid NULL)`,
  );
  await tx.unsafe(
    `SELECT caelo_journal_attach('${table}'::regclass, 'page', 'id', 'row', 'id', '', 'chat_branch_id', '', '')`,
  );
  await tx.unsafe(`INSERT INTO ${table} (id, v) VALUES (gen_random_uuid(), 'a')`);
  await tx.unsafe(`UPDATE ${table} SET v = 'b'`);
  await tx.unsafe(`DELETE FROM ${table}`);
}

/** Rolls back whatever `fn` did: these tests only measure. */
class Rollback extends Error {}

async function measured<T>(sql: SQL, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await sql
    .begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out as T;
}

let sql: SQL;

beforeAll(() => {
  // One connection: every statement and every measurement is the same backend.
  sql = new SQL(superuserUrl("cms_admin"), { max: 1 });
});

afterAll(async () => {
  await sql.end();
});

describe("#1749 — trigger memory per database connection", () => {
  it("a journaled table costs a connection at most the journal copy budget per trigger", async () => {
    const { bytes, copies } = await measured(sql, async (tx) => {
      // The first table compiles what every copy shares (the statement
      // builder) once; the budget is about what each further table adds.
      await writeJournaledScratch(tx, 0);
      const before = await triggerBytes(tx);
      const copiesBefore = await compiledCopies(tx, "caelo_journal_rows");
      for (let i = 1; i <= SCRATCH_TABLES; i++) await writeJournaledScratch(tx, i);
      return {
        bytes: (await triggerBytes(tx)) - before,
        copies: (await compiledCopies(tx, "caelo_journal_rows")) - copiesBefore,
      };
    });
    // insert, update and delete each compiled their own copy.
    expect(copies).toBe(SCRATCH_TABLES * 3);
    const perCopy = Math.round(bytes / copies);
    expect({ perCopy, withinBudget: perCopy <= JOURNAL_COPY_BUDGET_BYTES }).toEqual({
      perCopy,
      withinBudget: true,
    });
  });

  it("every trigger of the schema, fired once, stays within the per-trigger budget", async () => {
    const { bytes, triggers } = await measured(sql, async (tx) => {
      const tables = (await tx.unsafe(`
        SELECT c.oid::regclass::text AS rel, count(*)::int AS triggers,
               (SELECT quote_ident(a.attname) FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                   AND a.attgenerated = '' AND a.attidentity = ''
                 ORDER BY a.attnum LIMIT 1) AS col
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal AND c.relkind = 'r'
         GROUP BY c.oid
      `)) as { rel: string; triggers: number; col: string }[];
      const before = await triggerBytes(tx);
      for (const t of tables) {
        // Savepoints: a statement a table refuses (a check, a foreign key)
        // must not end the measurement. What a refused statement's
        // triggers compiled stays in the connection's memory all the same.
        for (const statement of [
          `UPDATE ${t.rel} SET ${t.col} = ${t.col} WHERE ctid = (SELECT ctid FROM ${t.rel} LIMIT 1)`,
          `UPDATE ${t.rel} SET ${t.col} = ${t.col} WHERE false`,
          `DELETE FROM ${t.rel} WHERE false`,
          `INSERT INTO ${t.rel} SELECT * FROM ${t.rel} WHERE false`,
        ]) {
          await tx.savepoint((sp) => sp.unsafe(statement)).catch(() => undefined);
        }
      }
      return {
        bytes: (await triggerBytes(tx)) - before,
        triggers: tables.reduce((n, t) => n + t.triggers, 0),
      };
    });
    expect(triggers).toBeGreaterThan(100);
    const perTrigger = Math.round(bytes / triggers);
    expect({ perTrigger, withinBudget: perTrigger <= SCHEMA_TRIGGER_BUDGET_BYTES }).toEqual({
      perTrigger,
      withinBudget: true,
    });
  });
});
