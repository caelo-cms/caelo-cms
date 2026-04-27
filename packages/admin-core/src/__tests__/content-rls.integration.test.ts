// SPDX-License-Identifier: MPL-2.0

/**
 * RLS coverage for the P3 content tables. A direct SQL connection that does
 * not call `set_config('caelo.actor_kind', ...)` matches no rows on the new
 * tables, even though it owns the database. Mirrors the pattern from the
 * existing P1 RLS adversarial suite.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const TPL_SLUG = "p3-rls-tpl";
const MOD_SLUG = "p3-rls-mod";
const PAGE_SLUG = "p3-rls-page";

let seededTemplateId = "";
let seededModuleId = "";
let seededPageId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = (await tx`
        INSERT INTO templates (slug, display_name, html)
        VALUES (${TPL_SLUG}, 'RLS T', '<body></body>')
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seededTemplateId = tpl[0]?.id ?? "";
      const mod = (await tx`
        INSERT INTO modules (slug, display_name, html)
        VALUES (${MOD_SLUG}, 'RLS M', '<p>x</p>')
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seededModuleId = mod[0]?.id ?? "";
      const pg = (await tx`
        INSERT INTO pages (slug, locale, name, title, template_id)
        VALUES (${PAGE_SLUG}, 'en', 'RLS P', 'RLS P', ${seededTemplateId}::uuid)
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seededPageId = pg[0]?.id ?? "";
      await tx`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${seededTemplateId}::uuid, 'content', 'Content', 0)
      `;
      await tx`
        INSERT INTO page_modules (page_id, block_name, position, module_id)
        VALUES (${seededPageId}::uuid, 'content', 0, ${seededModuleId}::uuid)
      `;
    });
  } finally {
    await sql.end();
  }
});

afterAll(async () => {
  await wipe();
});

describe("P3 content RLS", () => {
  it("anonymous (no caelo.actor_kind) sees zero rows on every content table", async () => {
    const sql = new SQL(ADMIN_URL!);
    try {
      // Run the SELECTs in one transaction with zero session settings.
      await sql.begin(async (tx) => {
        const m = (await tx`SELECT count(*)::int AS c FROM modules`) as unknown as { c: number }[];
        expect(m[0]?.c).toBe(0);
        const t = (await tx`SELECT count(*)::int AS c FROM templates`) as unknown as {
          c: number;
        }[];
        expect(t[0]?.c).toBe(0);
        const tb = (await tx`SELECT count(*)::int AS c FROM template_blocks`) as unknown as {
          c: number;
        }[];
        expect(tb[0]?.c).toBe(0);
        const p = (await tx`SELECT count(*)::int AS c FROM pages`) as unknown as { c: number }[];
        expect(p[0]?.c).toBe(0);
        const pm = (await tx`SELECT count(*)::int AS c FROM page_modules`) as unknown as {
          c: number;
        }[];
        expect(pm[0]?.c).toBe(0);
      });
    } finally {
      await sql.end();
    }
  });

  it("an authenticated session (any actor_kind) sees the seeded rows", async () => {
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'human'");
        const m =
          (await tx`SELECT count(*)::int AS c FROM modules WHERE slug = ${MOD_SLUG}`) as unknown as {
            c: number;
          }[];
        expect(m[0]?.c).toBe(1);
        const p =
          (await tx`SELECT count(*)::int AS c FROM pages WHERE slug = ${PAGE_SLUG}`) as unknown as {
            c: number;
          }[];
        expect(p[0]?.c).toBe(1);
      });
    } finally {
      await sql.end();
    }
  });
});
