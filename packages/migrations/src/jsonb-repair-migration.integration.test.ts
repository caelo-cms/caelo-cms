// SPDX-License-Identifier: MPL-2.0

/**
 * #68 — migration 0404 repairs jsonb values the pre-#283 write idiom
 * stored double-encoded (a jsonb string scalar holding JSON text).
 *
 * Rows of that shape are written the way bun:SQL wrote them (a JS string
 * bound under `::jsonb`), the migration file runs verbatim inside one
 * transaction — twice, to pin idempotency — and the transaction rolls
 * back. A genuine string value and a non-JSON string stay untouched, and
 * user_preferences (whose RLS admits only the row's own user) is repaired
 * too.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const FILE = join(
  import.meta.dir,
  "..",
  "migrations",
  "cms_admin",
  "0404_repair_jsonb_double_encoding.sql",
);

/** Migration body without its BEGIN/COMMIT, so it replays inside our transaction. */
function body(): string {
  return readFileSync(FILE, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/.test(line))
    .join("\n");
}

const USER = "00000000-0000-0000-0000-0000000068a1";
const M_DOUBLE = "00000000-0000-0000-0000-0000000068b1";
const M_TRIPLE = "00000000-0000-0000-0000-0000000068b2";
const FIELDS = [{ name: "title", kind: "text", label: "Title" }];

class Rollback extends Error {}

describe("0404 repairs double-encoded jsonb (#68)", () => {
  it("turns string scalars holding JSON objects/arrays back into objects/arrays, idempotently", async () => {
    const sql = new SQL(ADMIN_URL);
    let seen: Record<string, unknown> = {};
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        // The pre-#283 write: a JSON string bound under a bare ::jsonb cast.
        const doubled = JSON.stringify(FIELDS);
        await tx`
          INSERT INTO modules (id, slug, type, display_name, html, fields) VALUES
            (${M_DOUBLE}::uuid, 'jsonb68-double', 'jsonb68-double', 'D', '<p>{{title}}</p>', ${doubled}::jsonb),
            (${M_TRIPLE}::uuid, 'jsonb68-triple', 'jsonb68-triple', 'T', '<p>{{title}}</p>',
             to_jsonb(${JSON.stringify(doubled)}::text))
        `;
        const before = (await tx`
          SELECT jsonb_typeof(fields) AS t FROM modules WHERE id = ${M_DOUBLE}::uuid
        `) as { t: string }[];
        expect(before[0]?.t).toBe("string");

        await tx`INSERT INTO actors (id, kind, display_name) VALUES (${USER}::uuid, 'human', 'jsonb68')`;
        await tx`INSERT INTO users (id, email, password_hash) VALUES (${USER}::uuid, 'jsonb68@example.com', 'x')`;
        await tx.unsafe(`SELECT set_config('caelo.actor_id', '${USER}', true)`);
        await tx`
          INSERT INTO user_preferences (user_id, key, value) VALUES
            (${USER}::uuid, 'layout', ${JSON.stringify({ mode: "pinned" })}::jsonb),
            (${USER}::uuid, 'theme', to_jsonb('dark'::text)),
            (${USER}::uuid, 'note', to_jsonb('{not json'::text))
        `;
        await tx.unsafe("SELECT set_config('caelo.actor_id', '', true)");

        await tx.unsafe(body());
        await tx.unsafe(body());

        await tx.unsafe(`SELECT set_config('caelo.actor_id', '${USER}', true)`);
        const modules = (await tx`
          SELECT slug, jsonb_typeof(fields) AS t, fields->0->>'name' AS first
            FROM modules WHERE id IN (${M_DOUBLE}::uuid, ${M_TRIPLE}::uuid) ORDER BY slug
        `) as { slug: string; t: string; first: string }[];
        const prefs = (await tx`
          SELECT key, value FROM user_preferences WHERE user_id = ${USER}::uuid ORDER BY key
        `) as { key: string; value: unknown }[];
        seen = {
          modules,
          prefs: Object.fromEntries(prefs.map((p) => [p.key, p.value])),
        };
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    } finally {
      await sql.end();
    }
    expect(seen.modules).toEqual([
      { slug: "jsonb68-double", t: "array", first: "title" },
      { slug: "jsonb68-triple", t: "array", first: "title" },
    ]);
    expect(seen.prefs).toEqual({
      layout: { mode: "pinned" },
      // A genuine string and a string that is not JSON are left alone.
      note: "{not json",
      theme: "dark",
    });
  });
});
