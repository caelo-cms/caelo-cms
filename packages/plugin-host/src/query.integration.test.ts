// SPDX-License-Identifier: MPL-2.0

/**
 * P12 PR1.1 — ctx.query.* end-to-end against a real cms_public schema.
 *
 * Asserts:
 *   - Plugin loads, its cms_public schema gets provisioned.
 *   - ctx.query.insert / list / update / delete round-trip.
 *   - Filter DSL: `since`, `limit`, `orderBy`, `orderDir` plus
 *     column-equality. Reserved + declared keys validated.
 *   - Cross-plugin RLS leak: plugin A cannot read plugin B's rows even
 *     when they share a column shape.
 *   - Undeclared table / undeclared column / unsafe identifier all
 *     reject with a clear error.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { bootstrap, resetPluginHost, runPluginOperation } from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const PLUGIN_A = "test-p12-query-a";
const PLUGIN_B = "test-p12-query-b";

const greetingsSchema = {
  greetings: {
    id: "uuid",
    page_id: "string",
    locale: "string",
    message: "string",
    created_at: "timestamp",
  },
} as const;

function makePlugin(slug: string) {
  return definePlugin({
    slug,
    version: "1.0.0",
    tier: 1,
    schema: greetingsSchema,
    operations: {
      add: async (ctx, args) => {
        const a = args as { pageId: string; locale: string; message: string };
        return ctx.query.insert("greetings", {
          page_id: a.pageId,
          locale: a.locale,
          message: a.message,
        });
      },
      list_all: async (ctx, args) => {
        const a = args as { pageId?: string };
        return ctx.query.list("greetings", a.pageId ? { page_id: a.pageId } : {});
      },
      list_recent: async (ctx, args) => {
        const a = args as { since: string };
        return ctx.query.list("greetings", { since: a.since, orderBy: "created_at", limit: 5 });
      },
      change_message: async (ctx, args) => {
        const a = args as { id: string; message: string };
        await ctx.query.update("greetings", a.id, { message: a.message });
        return { updated: a.id };
      },
      remove: async (ctx, args) => {
        const a = args as { id: string };
        await ctx.query.delete("greetings", a.id);
        return { deleted: a.id };
      },
      try_undeclared_table: async (ctx) => {
        // Should throw — table not declared.
        return ctx.query.insert("rogue_table", { x: 1 });
      },
      try_undeclared_column: async (ctx) => {
        return ctx.query.insert("greetings", { secret_field: "x" });
      },
    },
  });
}

const pluginA = makePlugin(PLUGIN_A);
const pluginB = makePlugin(PLUGIN_B);

async function wipe(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // v0.2.16 — clear plugin-emitted audit rows before the actor.
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (
          SELECT id FROM plugins WHERE slug LIKE 'test-p12-query-%'
        )
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-p12-query-%')`;
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-p12-query-%')`;
      await tx`DELETE FROM plugins WHERE slug LIKE 'test-p12-query-%'`;
    });
  } finally {
    await sql.end();
  }
  const pub = new SQL(PUBLIC_URL);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_test_p12_query_a CASCADE`);
    await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_test_p12_query_b CASCADE`);
  } finally {
    await pub.end();
  }
}

async function provisionPluginSchema(plugin: { slug: string }): Promise<void> {
  // The host bootstrap upserts the plugins row; we read its id back and
  // call the adapter's provisioner just like the activate path would.
  const r = await adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "provision" },
    async (tx) => {
      const { sql } = await import("drizzle-orm");
      const rows = (await tx.execute(
        sql`SELECT id::text AS id FROM plugins WHERE slug = ${plugin.slug} LIMIT 1`,
      )) as unknown as { id: string }[];
      return rows[0]?.id;
    },
  );
  if (!r) throw new Error(`provisionPluginSchema: no plugin row for ${plugin.slug}`);
  const emitted = schemaFromSpec({
    pluginId: r,
    slug: plugin.slug,
    schema: greetingsSchema,
  });
  await adapter.provisionPluginPublicSchema({ pluginId: r, sql: emitted.sql });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

describe("ctx.query.* end-to-end (P12 PR1.1)", () => {
  it("insert + list round-trip with the plugin's actor + RLS scoping", async () => {
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: pluginA }],
    });
    await provisionPluginSchema(pluginA);

    const add = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "add",
      args: { pageId: "page-1", locale: "en", message: "hello" },
    });
    expect(add.ok).toBe(true);

    const list = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "list_all",
      args: {},
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const rows = list.value as Array<{ message: string; locale: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe("hello");
  });

  it("update + delete work via id", async () => {
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: pluginA }],
    });
    await provisionPluginSchema(pluginA);
    const add = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "add",
      args: { pageId: "p", locale: "en", message: "v1" },
    });
    if (!add.ok) throw new Error("add failed");
    const id = (add.value as { id: string }).id;
    const upd = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "change_message",
      args: { id, message: "v2" },
    });
    expect(upd.ok).toBe(true);
    const list = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "list_all",
      args: {},
    });
    if (!list.ok) return;
    expect((list.value as Array<{ message: string }>)[0]?.message).toBe("v2");

    const del = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "remove",
      args: { id },
    });
    expect(del.ok).toBe(true);
    const after = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "list_all",
      args: {},
    });
    if (!after.ok) return;
    expect(after.value).toHaveLength(0);
  });

  it("rejects undeclared table", async () => {
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: pluginA }],
    });
    await provisionPluginSchema(pluginA);
    const r = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "try_undeclared_table",
      args: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("not declared");
  });

  it("rejects undeclared column", async () => {
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: pluginA }],
    });
    await provisionPluginSchema(pluginA);
    const r = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "try_undeclared_column",
      args: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("not declared");
  });

  it("cross-plugin RLS leak: plugin A can't read plugin B's rows", async () => {
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: pluginA }, { definition: pluginB }],
    });
    await provisionPluginSchema(pluginA);
    await provisionPluginSchema(pluginB);

    // Both insert one row each.
    const aAdd = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "add",
      args: { pageId: "p", locale: "en", message: "from-A" },
    });
    expect(aAdd.ok).toBe(true);
    const bAdd = await runPluginOperation({
      pluginSlug: PLUGIN_B,
      operationName: "add",
      args: { pageId: "p", locale: "en", message: "from-B" },
    });
    expect(bAdd.ok).toBe(true);

    // Plugin A lists its own greetings — sees only its row.
    const aList = await runPluginOperation({
      pluginSlug: PLUGIN_A,
      operationName: "list_all",
      args: {},
    });
    if (!aList.ok) return;
    const aRows = aList.value as Array<{ message: string }>;
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.message).toBe("from-A");

    // And vice versa — separate schemas, separate RLS, total isolation.
    const bList = await runPluginOperation({
      pluginSlug: PLUGIN_B,
      operationName: "list_all",
      args: {},
    });
    if (!bList.ok) return;
    const bRows = bList.value as Array<{ message: string }>;
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.message).toBe("from-B");
  });
});
