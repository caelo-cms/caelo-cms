// SPDX-License-Identifier: MPL-2.0

/**
 * #1276 — migrations 0443 (pages.page_type_confirmed + snapshot backfill)
 * and 0444 (site_defaults' default page type / template become optional),
 * replayed against a fixture.
 *
 * The test database is already migrated, so the pre-0443 shape is rebuilt
 * inside one transaction: a scratch schema first on the search_path holds
 * the tables the migrations touch (only the columns they read), the
 * fixture goes in, the migration files run verbatim and the transaction
 * rolls back (the lists-migration test's pattern).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const DIR = join(import.meta.dir, "..", "migrations", "cms_admin");

/** Migration body without its BEGIN/COMMIT, so it replays inside our transaction. */
function body(file: string): string {
  return readFileSync(join(DIR, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/.test(line))
    .join("\n");
}

const ID = {
  defaultType: "10000000-0000-0000-0000-000000000001",
  newsType: "10000000-0000-0000-0000-000000000002",
  template: "20000000-0000-0000-0000-000000000001",
  pOrdinary: "30000000-0000-0000-0000-000000000001",
  pNews: "30000000-0000-0000-0000-000000000002",
  pBranched: "30000000-0000-0000-0000-000000000003",
};

const PRE_0443 = `
CREATE TABLE pages (id uuid PRIMARY KEY, page_type_id uuid NOT NULL, chat_branch_id uuid);
CREATE TABLE page_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), page_id uuid NOT NULL, state jsonb NOT NULL);
CREATE TABLE site_defaults (
  id int PRIMARY KEY,
  default_template_id uuid NOT NULL,
  default_page_type_id uuid NOT NULL);
`;

const FIXTURE = `
INSERT INTO site_defaults (id, default_template_id, default_page_type_id)
  VALUES (1, '${ID.template}', '${ID.defaultType}');
INSERT INTO pages (id, page_type_id, chat_branch_id) VALUES
  ('${ID.pOrdinary}', '${ID.defaultType}', NULL),
  ('${ID.pNews}', '${ID.newsType}', NULL),
  ('${ID.pBranched}', '${ID.defaultType}', gen_random_uuid());
INSERT INTO page_snapshots (page_id, state) VALUES
  ('${ID.pOrdinary}', '{"slug":"about","pageTypeId":"${ID.defaultType}"}'),
  ('${ID.pNews}', '{"slug":"post","pageTypeId":"${ID.newsType}"}'),
  ('${ID.pNews}', '{"slug":"old","templateId":"${ID.template}"}');
`;

describe("migrations 0443–0444 (#1276)", () => {
  it("marks only pages on the old default type unconfirmed and relaxes site_defaults", async () => {
    const sql = new SQL(ADMIN_URL as string);
    const conn = await sql.reserve();
    try {
      await conn`BEGIN`;
      await conn`SELECT set_config('caelo.actor_kind', 'system', true)`;
      await conn.unsafe("CREATE SCHEMA t1276_mig");
      await conn.unsafe("SET LOCAL search_path = t1276_mig, public");
      await conn.unsafe(PRE_0443);
      await conn.unsafe(FIXTURE);
      await conn.unsafe(body("0443_pages_page_type_confirmed.sql"));
      await conn.unsafe(body("0444_site_defaults_no_default_page_type.sql"));

      const pages = (await conn`
        SELECT id::text AS id, page_type_confirmed AS c FROM pages
      `) as { id: string; c: boolean }[];
      const confirmed = new Map(pages.map((p) => [p.id, p.c]));
      expect(confirmed.get(ID.pOrdinary)).toBe(false);
      expect(confirmed.get(ID.pBranched)).toBe(false);
      expect(confirmed.get(ID.pNews)).toBe(true);

      const notNull = (await conn`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 't1276_mig' AND table_name = 'pages' AND column_name = 'page_type_confirmed'
      `) as { is_nullable: string }[];
      expect(notNull[0]?.is_nullable).toBe("NO");
      // No column default: a raw INSERT must state the flag.
      await conn`SAVEPOINT no_default`;
      await expect(
        conn`INSERT INTO pages (id, page_type_id) VALUES (gen_random_uuid(), ${ID.newsType}::uuid)`,
      ).rejects.toThrow("page_type_confirmed");
      await conn`ROLLBACK TO SAVEPOINT no_default`;

      const snaps = (await conn`
        SELECT state FROM page_snapshots ORDER BY state->>'slug'
      `) as { state: Record<string, unknown> }[];
      const bySlug = new Map(snaps.map((s) => [s.state.slug, s.state]));
      expect(bySlug.get("about")?.pageTypeConfirmed).toBe(false);
      expect(bySlug.get("post")?.pageTypeConfirmed).toBe(true);
      // A snapshot without pageTypeId (refused on revert since 0351) keeps its shape.
      expect(bySlug.get("old")).not.toHaveProperty("pageTypeConfirmed");

      const cols = (await conn`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 't1276_mig' AND table_name = 'site_defaults'
          AND column_name IN ('default_template_id', 'default_page_type_id')
        ORDER BY column_name
      `) as { column_name: string; is_nullable: string }[];
      expect(cols).toEqual([
        { column_name: "default_page_type_id", is_nullable: "YES" },
        { column_name: "default_template_id", is_nullable: "YES" },
      ]);
    } finally {
      await conn`ROLLBACK`;
      conn.release();
      await sql.end();
    }
  });
});
