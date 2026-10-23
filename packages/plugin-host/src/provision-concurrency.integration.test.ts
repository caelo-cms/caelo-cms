// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — several admin instances booting in the same second all
 * provision the same plugin schema. On 2026-10-22 four Cloud Run
 * instances did exactly that and the concurrent IF-NOT-EXISTS DDL failed
 * on one of them. Each adapter here owns its own pool, like separate
 * instances; every provisioning call must succeed and leave one intact
 * schema behind.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { adminSchemaFromSpec, schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const INSTANCES = 6;
const SLUG = "t1008-race";
const SCHEMA = "plugin_t1008_race";
const PLUGIN_ID = "6b1f5a3e-4c2d-4e8f-9a1b-2c3d4e5f6a70";

let adapters: DatabaseAdapter[] = [];

async function dropSchemas(): Promise<void> {
  for (const url of [ADMIN_URL, PUBLIC_URL] as const) {
    const sql = new SQL(url);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await tx.unsafe(`DELETE FROM plugin_schema_provisions WHERE schema_name = '${SCHEMA}'`);
      });
    } finally {
      await sql.end();
    }
  }
}

async function tablesIn(url: string): Promise<string[]> {
  const sql = new SQL(url);
  try {
    const rows = (await sql.unsafe(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = '${SCHEMA}' AND c.relkind = 'r' ORDER BY c.relname`,
    )) as { relname: string }[];
    return rows.map((r) => r.relname);
  } finally {
    await sql.end();
  }
}

const schema = {
  locales: { code: "text", display_name: "text", is_default: "bool" },
  glossary: { term: "text", translation: "text" },
};

beforeAll(async () => {
  adapters = Array.from(
    { length: INSTANCES },
    () => new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL }),
  );
  await dropSchemas();
});

afterAll(async () => {
  await dropSchemas();
  await Promise.all(adapters.map((a) => a.close()));
});

describe("#1008 — concurrent plugin schema provisioning", () => {
  it("cms_public: every instance succeeds and one schema results", async () => {
    const emitted = schemaFromSpec({ pluginId: PLUGIN_ID, slug: SLUG, schema });
    const results = await Promise.allSettled(
      adapters.map((a) => a.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: emitted.sql })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await tablesIn(PUBLIC_URL)).toEqual(["glossary", "locales"]);
  });

  it("cms_admin: every instance succeeds and one schema results", async () => {
    const emitted = adminSchemaFromSpec({ pluginId: PLUGIN_ID, slug: SLUG, adminSchema: schema });
    const results = await Promise.allSettled(
      adapters.map((a) => a.provisionPluginAdminSchema({ pluginId: PLUGIN_ID, sql: emitted.sql })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await tablesIn(ADMIN_URL)).toEqual(["glossary", "locales"]);
  });

  it("re-provisioning the same SQL skips the DDL (no ACCESS EXCLUSIVE on a live table)", async () => {
    const emitted = schemaFromSpec({ pluginId: PLUGIN_ID, slug: SLUG, schema });
    const first = adapters[0];
    if (!first) throw new Error("no adapter");
    // A concurrent reader holding a row lock-free SELECT open would block
    // behind DROP/CREATE POLICY. With the digest recorded, re-provisioning
    // must not take any table lock, so it finishes while the reader's
    // transaction is still open.
    const reader = new SQL(PUBLIC_URL);
    try {
      await reader.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx.unsafe(`LOCK TABLE "${SCHEMA}"."locales" IN ACCESS SHARE MODE`);
        const done = await Promise.race([
          first
            .provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: emitted.sql })
            .then(() => "done"),
          Bun.sleep(3000).then(() => "blocked"),
        ]);
        expect(done).toBe("done");
      });
    } finally {
      await reader.end();
    }
  });

  it("a changed spec re-runs the DDL (additive evolution still applies)", async () => {
    const evolved = schemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: SLUG,
      schema: { ...schema, style_guides: { body: "text" } },
    });
    const first = adapters[0];
    if (!first) throw new Error("no adapter");
    await first.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: evolved.sql });
    expect(await tablesIn(PUBLIC_URL)).toEqual(["glossary", "locales", "style_guides"]);
  });

  it("a dropped schema is re-created even when its digest was recorded", async () => {
    const emitted = schemaFromSpec({ pluginId: PLUGIN_ID, slug: SLUG, schema });
    const first = adapters[0];
    if (!first) throw new Error("no adapter");
    await first.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: emitted.sql });
    await first.dropPluginPublicSchema({ schemaName: SCHEMA });
    await first.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: emitted.sql });
    expect(await tablesIn(PUBLIC_URL)).toEqual(["glossary", "locales"]);
  });
});
