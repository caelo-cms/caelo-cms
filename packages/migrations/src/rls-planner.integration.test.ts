// SPDX-License-Identifier: MPL-2.0

/**
 * #1297 — how row-level security shapes the plans of admin reads, and the
 * two rules that follow from it.
 *
 * 1. A policy term without column references (`current_setting(...) =
 *    'x'`) is never a one-time filter: Postgres keeps policy quals at the
 *    scan they protect, so the term is a row filter estimated with the
 *    no-statistics default — 0.5 % of the rows. Spelled through
 *    `caelo_setting_is` / `caelo_setting_in` (migration 0475) it is
 *    estimated at 99.5 % with the same truth table. Rule: no policy in
 *    either database (core or plugin schema) spells such a term the old
 *    way.
 * 2. A user predicate that is not LEAKPROOF runs after the policy, so it
 *    can never be an index condition on an RLS table. ILIKE is not
 *    leakproof, so a trigram index never serves `ILIKE '%q%'` for
 *    admin_role. Rule: no trigram index on an RLS table.
 *
 * The planner proofs run as admin_role (the role every admin read uses)
 * on a scratch table with FORCEd RLS and realistic row counts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL) {
  throw new Error("ADMIN_DATABASE_URL and PUBLIC_ADMIN_DATABASE_URL required (see .env.example)");
}

const LAB = "t1297_rls_planner";
const ROWS = 3000;
const PLUGIN_ID = "12970000-0000-4000-8000-000000001297";

/**
 * A Var-free comparison of a session setting with literals, as
 * `pg_get_expr` prints it: `current_setting('caelo.x'::text, true) = 'v'::text`
 * or `... = ANY (ARRAY['a'::text, ...])`. A comparison with a column
 * (`(plugin_id)::text = current_setting(...)`) does not match: the planner
 * estimates that one from the column's statistics.
 */
const VAR_FREE_SETTING_TEST = /current_setting\('[^']+'::text, true\) = (?:ANY \(ARRAY\[)?'/;

interface PolicyRow {
  readonly schema: string;
  readonly table: string;
  readonly policy: string;
  readonly qual: string | null;
  readonly check: string | null;
}

async function policies(url: string): Promise<PolicyRow[]> {
  const db = new SQL(url);
  try {
    return (await db`
      SELECT n.nspname AS schema, c.relname AS table, p.polname AS policy,
             pg_get_expr(p.polqual, p.polrelid) AS qual,
             pg_get_expr(p.polwithcheck, p.polrelid) AS check
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> ${LAB}
      ORDER BY 1, 2, 3
    `) as PolicyRow[];
  } finally {
    await db.end();
  }
}

async function trigramIndexesOnRlsTables(url: string): Promise<string[]> {
  const db = new SQL(url);
  try {
    const rows = (await db`
      SELECT DISTINCT n.nspname || '.' || i.relname AS name
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_opclass oc ON oc.oid = ANY (x.indclass::oid[])
      WHERE t.relrowsecurity AND oc.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')
        AND n.nspname <> ${LAB}
      ORDER BY 1
    `) as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    await db.end();
  }
}

describe("#1297 — RLS policy rules", () => {
  for (const [label, url] of [
    ["cms_admin", ADMIN_URL],
    ["cms_public", PUBLIC_ADMIN_URL],
  ] as const) {
    it(`${label}: no policy compares a session setting with literals directly`, async () => {
      const offenders = (await policies(url))
        .filter((p) => [p.qual, p.check].some((e) => e !== null && VAR_FREE_SETTING_TEST.test(e)))
        .map((p) => `${p.schema}.${p.table} ${p.policy}`);
      // Spell `current_setting('caelo.x', true) = 'v'` as
      // caelo_setting_is('caelo.x', 'v') and `= ANY (ARRAY[...])` as
      // caelo_setting_in('caelo.x', ARRAY[...]) — see migration 0475.
      expect(offenders).toEqual([]);
    });

    it(`${label}: no trigram index on a table with row-level security`, async () => {
      // An ILIKE under RLS is always a row filter; such an index only costs writes (0476).
      expect(await trigramIndexesOnRlsTables(url)).toEqual([]);
    });
  }
});

interface PlanNode {
  readonly "Node Type": string;
  readonly "Plan Rows": number;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Index Cond"?: string;
  readonly "Recheck Cond"?: string;
  readonly Plans?: readonly PlanNode[];
}

const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

let db: SQL;

beforeAll(async () => {
  db = new SQL(ADMIN_URL);
  await db.unsafe(`DROP SCHEMA IF EXISTS ${LAB} CASCADE`);
  await db.unsafe(`CREATE SCHEMA ${LAB}`);
  await db.unsafe(`
    CREATE TABLE ${LAB}.rows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL,
      body text NOT NULL
    )`);
  await db.unsafe(`
    INSERT INTO ${LAB}.rows (created_at, body)
    SELECT now() - i * interval '1 minute', '/old/section-' || (i % 50) || '/' || md5(i::text)
    FROM generate_series(1, ${ROWS}) AS i`);
  await db.unsafe(`CREATE INDEX rows_created_at_idx ON ${LAB}.rows (created_at)`);
  await db.unsafe(`CREATE INDEX rows_body_trgm_idx ON ${LAB}.rows USING gin (body gin_trgm_ops)`);
  await db.unsafe(`ANALYZE ${LAB}.rows`);
  await db.unsafe(`ALTER TABLE ${LAB}.rows ENABLE ROW LEVEL SECURITY`);
  // admin_role owns the table: FORCE makes the policy apply to it, as on every Caelo table.
  await db.unsafe(`ALTER TABLE ${LAB}.rows FORCE ROW LEVEL SECURITY`);
});

afterAll(async () => {
  await db.unsafe(`DROP SCHEMA IF EXISTS ${LAB} CASCADE`);
  await db.end();
});

/** Replace the scratch table's policy and plan `query` as admin_role with the plugin id set. */
async function planWith(policy: string, query: string): Promise<PlanNode> {
  return db.begin(async (tx) => {
    await tx.unsafe(`DROP POLICY IF EXISTS scope ON ${LAB}.rows`);
    await tx.unsafe(`CREATE POLICY scope ON ${LAB}.rows USING (${policy})`);
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${PLUGIN_ID}', true)`);
    const rows = (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`)) as Array<
      Record<string, unknown>
    >;
    const raw = rows[0]?.["QUERY PLAN"];
    const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
    const root = plan[0]?.Plan;
    if (!root) throw new Error(`no plan for ${query}`);
    return root;
  });
}

const OLD_SCOPE = `current_setting('caelo.plugin_id', true) = '${PLUGIN_ID}'`;
const NEW_SCOPE = `caelo_setting_is('caelo.plugin_id', '${PLUGIN_ID}')`;
const scanOf = (root: PlanNode) =>
  nodesOf(root).find((n) => n["Relation Name"] === "rows") as PlanNode;

describe("#1297 — the planner under a FORCEd policy (admin_role)", () => {
  const ORDERED = `SELECT * FROM ${LAB}.rows ORDER BY created_at DESC LIMIT 50`;

  it("estimates a plain setting comparison at 0.5 % of the rows — the root cause", async () => {
    const all = await planWith(OLD_SCOPE, `SELECT * FROM ${LAB}.rows`);
    expect(scanOf(all)["Plan Rows"]).toBeLessThan(ROWS * 0.01);
  });

  it("estimates caelo_setting_is as passing nearly every row", async () => {
    const all = await planWith(NEW_SCOPE, `SELECT * FROM ${LAB}.rows`);
    expect(scanOf(all)["Plan Rows"]).toBeGreaterThan(ROWS * 0.99);
  });

  it("an unfiltered ORDER BY … LIMIT reads its index in order under caelo_setting_is", async () => {
    const plan = await planWith(NEW_SCOPE, ORDERED);
    const types = nodesOf(plan).map((n) => n["Node Type"]);
    expect(types).not.toContain("Sort");
    expect(nodesOf(plan).some((n) => n["Index Name"] === "rows_created_at_idx")).toBe(true);
  });

  it("the same read under the plain comparison sorts the whole table", async () => {
    const plan = await planWith(OLD_SCOPE, ORDERED);
    expect(nodesOf(plan).map((n) => n["Node Type"])).toContain("Sort");
  });

  it("keeps the same truth table: only the configured plugin id passes", async () => {
    const count = (setting: string | null) =>
      db.begin(async (tx) => {
        await tx.unsafe(`DROP POLICY IF EXISTS scope ON ${LAB}.rows`);
        await tx.unsafe(`CREATE POLICY scope ON ${LAB}.rows USING (${NEW_SCOPE})`);
        if (setting !== null) {
          await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${setting}', true)`);
        }
        const r = (await tx.unsafe(`SELECT count(*)::int AS n FROM ${LAB}.rows`)) as {
          n: number;
        }[];
        return r[0]?.n;
      });
    expect(await count(PLUGIN_ID)).toBe(ROWS);
    expect(await count("12970000-0000-4000-8000-000000000000")).toBe(0);
    expect(await count("")).toBe(0);
    expect(await count(null)).toBe(0);
  });

  it("ILIKE never becomes an index condition under RLS, so a trigram index is dead weight", async () => {
    const search = `SELECT * FROM ${LAB}.rows WHERE body ILIKE '%3f2a%'`;
    const conds = (root: PlanNode) =>
      nodesOf(root).flatMap((n) => [n["Index Cond"], n["Recheck Cond"]].filter(Boolean));
    // Under the policy: the ILIKE runs after it, as a row filter.
    expect(conds(await planWith(NEW_SCOPE, search))).toEqual([]);
    // The control: without RLS the same index drives the same predicate.
    const unprotected = await db.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE ${LAB}.rows NO FORCE ROW LEVEL SECURITY`);
      const rows = (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${search}`)) as Array<
        Record<string, unknown>
      >;
      await tx.unsafe(`ALTER TABLE ${LAB}.rows FORCE ROW LEVEL SECURITY`);
      const raw = rows[0]?.["QUERY PLAN"];
      return ((typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>)[0]
        ?.Plan as PlanNode;
    });
    expect(conds(unprotected).join(" ")).toContain("~~*");
  });
});
