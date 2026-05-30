// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — verifies migration 0103's two behaviours against
 * the real cms_admin Postgres (AC #3): the modules.type NOT NULL column
 * and the allowedModuleSlugs -> allowedModuleTypes rename inside the
 * stored modules.fields JSON, applied idempotently.
 *
 * The migration is already applied to the test DB, so rather than rewind
 * the schema we (a) assert the NOT NULL column is enforced, and (b)
 * re-run the migration's idempotent JSON-rewrite against a seeded
 * legacy-shaped row and assert it renames the key on nested fields only,
 * leaves plain fields + order untouched, and is a no-op on a second run.
 *
 * Conventions: Bun's native SQL with a system actor context (RLS).
 * The legacy `fields` are seeded via jsonb_build_array (NOT a bound
 * JSON.stringify, which bun:SQL double-encodes into a jsonb STRING scalar
 * that the migration's `jsonb_typeof = 'array'` guard would skip). jsonb
 * is read back via `::text` + JSON.parse.
 */

import { SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const sql = new SQL(ADMIN_URL);

afterAll(async () => {
  await sql.end();
});

// The JSON-rename from migration 0103, scoped to one row. Idempotent via
// the EXISTS guard.
function runRename(tx: SQL, id: string) {
  return tx`
    UPDATE modules
      SET fields = (
        SELECT jsonb_agg(
          CASE
            WHEN elem ? 'allowedModuleSlugs'
              THEN (elem - 'allowedModuleSlugs')
                   || jsonb_build_object('allowedModuleTypes', elem -> 'allowedModuleSlugs')
            ELSE elem
          END
          ORDER BY ord
        )
        FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(elem, ord)
      )
      WHERE id = ${id}::uuid
        AND jsonb_typeof(fields) = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(fields) AS e WHERE e ? 'allowedModuleSlugs'
        )`;
}

describe("migration 0103 — modules.type NOT NULL", () => {
  it("rejects an INSERT that omits type (column is NOT NULL, no default)", async () => {
    const slug = `m0103-nn-${Date.now().toString(36)}`;
    let msg = "";
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`INSERT INTO modules (slug, display_name, html) VALUES (${slug}, 'NN', '<p>x</p>')`;
      });
    } catch (e) {
      msg = String((e as { message?: string }).message ?? e);
    }
    expect(msg).toContain('column "type"');
    expect(msg.toLowerCase()).toContain("null");
  });
});

describe("migration 0103 — allowedModuleSlugs -> allowedModuleTypes JSON rename", () => {
  it("renames nested fields only, preserves plain fields + order, and is idempotent", async () => {
    const slug = `m0103-rn-${Date.now().toString(36)}`;

    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const ins = await tx`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (${slug}, 'Legacy', ${slug}, '<div></div>',
          jsonb_build_array(
            jsonb_build_object('name','cta','kind','module','label','CTA',
              'allowedModuleSlugs', jsonb_build_array('button')),
            jsonb_build_object('name','title','kind','text','label','Title'),
            jsonb_build_object('name','cards','kind','module-list','label','Cards',
              'allowedModuleSlugs', jsonb_build_array('card'))
          ))
        RETURNING id::text AS id, jsonb_typeof(fields) AS jt`;
      const id = ins[0].id as string;
      // Sanity: the seed is a real jsonb array (not a double-encoded string).
      expect(ins[0].jt).toBe("array");

      await runRename(tx, id);
      const after = await tx`SELECT fields::text AS fields FROM modules WHERE id = ${id}::uuid`;
      const fields = JSON.parse(after[0].fields as string) as Array<Record<string, unknown>>;
      const byName = Object.fromEntries(fields.map((f) => [f.name as string, f]));

      expect(byName.cta.allowedModuleTypes).toEqual(["button"]);
      expect("allowedModuleSlugs" in byName.cta).toBe(false);
      expect(byName.cards.allowedModuleTypes).toEqual(["card"]);
      expect("allowedModuleSlugs" in byName.cards).toBe(false);
      // plain field untouched — no spurious key added
      expect("allowedModuleTypes" in byName.title).toBe(false);
      expect("allowedModuleSlugs" in byName.title).toBe(false);
      // field order preserved
      expect(fields.map((f) => f.name)).toEqual(["cta", "title", "cards"]);

      // Idempotent: a second run renames nothing (EXISTS guard fails).
      const before2 = JSON.stringify(fields);
      await runRename(tx, id);
      const after2 = await tx`SELECT fields::text AS fields FROM modules WHERE id = ${id}::uuid`;
      expect(JSON.stringify(JSON.parse(after2[0].fields as string))).toBe(before2);
    });
  });
});
