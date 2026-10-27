// SPDX-License-Identifier: MPL-2.0

/**
 * #1146 — a plugin version that stops declaring a column gets it dropped
 * on provisioning, in both databases, with an audit row; the row id and
 * the host-owned `caelo_` columns stay.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { adminSchemaFromSpec, schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SLUG = "t1146-drop";
const SCHEMA = "plugin_t1146_drop";
const PLUGIN_ID = "7c2e6b4f-5d3e-4f90-8b2c-3d4e5f6a7b81";
let adapter: DatabaseAdapter;

async function asSystem<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function dropSchemas(): Promise<void> {
  for (const url of [ADMIN_URL, PUBLIC_URL] as const) {
    await asSystem(url, async (tx) => {
      await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await tx.unsafe(`DELETE FROM plugin_schema_provisions WHERE schema_name = '${SCHEMA}'`);
    });
  }
  await asSystem(ADMIN_URL as string, (tx) =>
    tx.unsafe(`DELETE FROM audit_events WHERE entity_id = '${PLUGIN_ID}'`),
  );
}

async function columns(url: string, table: string): Promise<string[]> {
  const rows = (await asSystem(url, (tx) =>
    tx.unsafe(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = '${SCHEMA}' AND table_name = '${table}' ORDER BY column_name`),
  )) as { column_name: string }[];
  return rows.map((r) => r.column_name);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  await dropSchemas();
});

afterAll(async () => {
  await dropSchemas();
  await adapter.close();
});

describe("#1146 — columns a new plugin version no longer declares", () => {
  it("cms_public: drops the column and audits the drop", async () => {
    const v1 = schemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: SLUG,
      schema: { log: { consent_id: "uuid", visitor_id: "string", created_at: "timestamp" } },
    });
    await adapter.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: v1.sql });
    expect(await columns(PUBLIC_URL, "log")).toContain("visitor_id");

    const v2 = schemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: SLUG,
      schema: { log: { consent_id: "uuid", created_at: "timestamp" } },
    });
    await adapter.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: v2.sql });
    expect(await columns(PUBLIC_URL, "log")).toEqual(["consent_id", "created_at", "id"]);

    const audit = (await asSystem(ADMIN_URL, (tx) =>
      tx.unsafe(`SELECT result_summary FROM audit_events
        WHERE entity_id = '${PLUGIN_ID}' AND operation = 'plugins.schema_drop_columns'`),
    )) as { result_summary: string }[];
    expect(audit.map((a) => a.result_summary)).toEqual([
      `cms_public.${SCHEMA}: dropped log.visitor_id`,
    ]);
  });

  it("cms_admin: drops the column, keeps id and the host caelo_ columns", async () => {
    const v1 = adminSchemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: SLUG,
      adminSchema: { notes: { body: "text", ip_hash: "string" } },
    });
    await adapter.provisionPluginAdminSchema({ pluginId: PLUGIN_ID, sql: v1.sql });
    const v2 = adminSchemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: SLUG,
      adminSchema: { notes: { body: "text" } },
    });
    await adapter.provisionPluginAdminSchema({ pluginId: PLUGIN_ID, sql: v2.sql });
    const cols = await columns(ADMIN_URL, "notes");
    expect(cols).not.toContain("ip_hash");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "body",
        "caelo_chat_branch_id",
        "caelo_deleted_at",
        "caelo_version",
      ]),
    );

    // An unchanged spec drops nothing and records nothing more.
    await adapter.provisionPluginAdminSchema({ pluginId: PLUGIN_ID, sql: v2.sql });
    const audit = (await asSystem(ADMIN_URL, (tx) =>
      tx.unsafe(`SELECT result_summary FROM audit_events
        WHERE entity_id = '${PLUGIN_ID}' AND operation = 'plugins.schema_drop_columns'
        ORDER BY created_at`),
    )) as { result_summary: string }[];
    expect(audit.map((a) => a.result_summary)).toEqual([
      `cms_public.${SCHEMA}: dropped log.visitor_id`,
      `cms_admin.${SCHEMA}: dropped notes.ip_hash`,
    ]);
  });
});
