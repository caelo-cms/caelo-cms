// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: a page INSERTed outside the write ops (test seeds, import
 * tooling) gets its current_path from the 0211/0221 trigger. A home slug
 * must land at "/" when no home page is designated — the real-AI consent
 * scenario failed staging ("no page serves the site root") because its
 * seeded `home` page sat at "/home" and nothing recomposed it.
 */

import { expect, test } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const ROLLBACK = new Error("rollback");

test("raw-inserted home slugs default to the root unless another page is designated", async () => {
  const sql = new SQL(ADMIN_URL);
  const paths: Record<string, string> = {};
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // Start from a site with no root page and no designation.
      await tx`UPDATE site_defaults SET home_page_id = NULL WHERE id = 1`;
      await tx`DELETE FROM pages`;
      const tpl = (await tx`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES ('t-default-path', 'Default path', '<body></body>',
                (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const templateId = tpl[0]?.id ?? "";
      const insert = async (slug: string) => {
        const rows = (await tx`
          INSERT INTO pages (slug, name, title, template_id)
          VALUES (${slug}, ${slug}, ${slug}, ${templateId}::uuid)
          RETURNING id::text AS id, current_path
        `) as unknown as { id: string; current_path: string }[];
        paths[slug] = rows[0]?.current_path ?? "";
        return rows[0]?.id ?? "";
      };
      await insert("home");
      const about = await insert("about");
      // Once a page is designated, a home slug is just a slug.
      await tx`UPDATE site_defaults SET home_page_id = ${about}::uuid WHERE id = 1`;
      await insert("index");
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  } finally {
    await sql.end();
  }
  expect(paths).toEqual({ home: "/", about: "/about", index: "/index" });
});
