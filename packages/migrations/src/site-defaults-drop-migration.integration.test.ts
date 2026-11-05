// SPDX-License-Identifier: MPL-2.0

/**
 * #1279 — migration 0649 drops the columns 0444 made optional (the contract
 * half of #1276).
 *
 * Three things can go wrong that a plain "migrations ran" check misses: the
 * drop could take the row or `default_layout_id` with it, an install that
 * skips the expand release could run it, and a plpgsql body can name a
 * dropped column without Postgres noticing until the function runs. The
 * replay rebuilds the pre-0649 shape in a scratch schema inside one
 * transaction and rolls back (the lists-migration test's pattern); the
 * catalog checks read the fully migrated test database.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { requiredEarlierRuns, runOrderViolations } from "./run-order.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const DIR = join(import.meta.dir, "..", "migrations", "cms_admin");
const CONTRACT = "0649_drop_site_default_page_type.sql";
const EXPAND = "0444_site_defaults_no_default_page_type.sql";
const contractBody = readFileSync(join(DIR, CONTRACT), "utf8");

/** Migration body without its BEGIN/COMMIT, so it replays inside our transaction. */
function replayable(sqlText: string): string {
  return sqlText
    .split("\n")
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/.test(line))
    .join("\n");
}

const ID = {
  layout: "10000000-0000-0000-0000-000000000001",
  template: "20000000-0000-0000-0000-000000000001",
  pageType: "30000000-0000-0000-0000-000000000001",
};

const FIXTURE = `
CREATE TABLE layouts (id uuid PRIMARY KEY);
CREATE TABLE templates (id uuid PRIMARY KEY);
CREATE TABLE page_types (id uuid PRIMARY KEY);
CREATE TABLE site_defaults (
  id int PRIMARY KEY,
  default_layout_id uuid NOT NULL REFERENCES layouts(id),
  default_template_id uuid REFERENCES templates(id),
  default_page_type_id uuid REFERENCES page_types(id));
INSERT INTO layouts VALUES ('${ID.layout}');
INSERT INTO templates VALUES ('${ID.template}');
INSERT INTO page_types VALUES ('${ID.pageType}');
INSERT INTO site_defaults (id, default_layout_id, default_template_id, default_page_type_id)
VALUES (1, '${ID.layout}', '${ID.template}', '${ID.pageType}');
`;

describe("0649 drops the stored default page type and template (#1279)", () => {
  it("drops both columns and their foreign keys, keeps the row and the default layout", async () => {
    const sql = new SQL(ADMIN_URL);
    const conn = await sql.reserve();
    try {
      await conn.unsafe("BEGIN");
      await conn.unsafe(`CREATE SCHEMA t1279_mig; SET LOCAL search_path = t1279_mig, public;`);
      await conn.unsafe(FIXTURE);
      await conn.unsafe(replayable(contractBody));

      const cols = (await conn`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 't1279_mig' AND table_name = 'site_defaults'
        ORDER BY column_name
      `) as { column_name: string }[];
      expect(cols.map((c) => c.column_name)).toEqual(["default_layout_id", "id"]);

      const fks = (await conn`
        SELECT confrelid::regclass::text AS parent FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 't1279_mig.site_defaults'::regclass
      `) as { parent: string }[];
      expect(fks.map((f) => f.parent)).toEqual(["layouts"]);

      const row = (await conn`
        SELECT id, default_layout_id::text AS layout FROM site_defaults
      `) as { id: number; layout: string }[];
      expect(row).toEqual([{ id: 1, layout: ID.layout }]);

      // Nothing restricts a delete of the former parents any more.
      await conn`DELETE FROM templates`;
      await conn`DELETE FROM page_types`;
    } finally {
      await conn`ROLLBACK`;
      conn.release();
      await sql.end();
    }
  });

  it("is declared contract and refuses an install that skips the expand release", () => {
    expect(contractBody).toMatch(/^-- caelo:contract \S/m);
    expect(requiredEarlierRuns(contractBody)).toEqual([EXPAND]);
    const pending = [{ name: CONTRACT, body: contractBody }];
    const available = [EXPAND, CONTRACT];

    const skipped = runOrderViolations({
      pending,
      appliedBefore: new Set(["0443_pages_page_type_confirmed.sql"]),
      available,
    });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(`${CONTRACT} needs ${EXPAND} applied by an EARLIER`);

    expect(runOrderViolations({ pending, appliedBefore: new Set([EXPAND]), available })).toEqual(
      [],
    );
    // A fresh database has nothing serving, so everything applies in one run.
    expect(runOrderViolations({ pending, appliedBefore: new Set(), available })).toEqual([]);
  });

  it("leaves nothing in the migrated schema that names a dropped column", async () => {
    const sql = new SQL(ADMIN_URL);
    try {
      const cols = (await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'site_defaults'
          AND column_name IN ('default_template_id', 'default_page_type_id')
      `) as { column_name: string }[];
      expect(cols).toEqual([]);

      // Postgres does not track plpgsql bodies as dependents: one naming a
      // dropped column would pass the DROP and fail when it first ran.
      const bodies = (await sql`
        SELECT p.proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.prosrc ~ 'default_template_id' OR p.prosrc ~ 'default_page_type_id')
      `) as { proname: string }[];
      expect(bodies).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});
