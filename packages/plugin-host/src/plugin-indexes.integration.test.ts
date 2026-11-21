// SPDX-License-Identifier: MPL-2.0

/**
 * #1292 — plugin table indexes against real Postgres: the emitters create
 * the declared and automatic indexes in both databases, a new version
 * drops what it no longer declares and keeps the rest untouched, and the
 * storage `list` operation refuses a filter no index covers.
 * (The shipped plugins' reads: admin-core
 * `plugin-indexes-shipped.integration.test.ts`.)
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  adminSchemaFromSpec,
  PRIVATE_LIVE_ROW_PREDICATE,
  pluginIndexName,
  schemaFromSpec,
} from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { registerPluginStorageOps, STORAGE_OPS } from "./storage-ops.js";

function requiredUrl(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} required`);
  return url;
}
const ADMIN_URL = requiredUrl("ADMIN_DATABASE_URL");
const PUBLIC_URL = requiredUrl("PUBLIC_ADMIN_DATABASE_URL");

const SLUG = "t1292-ix";
const SCHEMA = "plugin_t1292_ix";
const PLUGIN_ID = "1292aaaa-5d3e-4f90-8b2c-3d4e5f6a7b81";
let adapter: DatabaseAdapter;

async function asSystem<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(url);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await db.end();
  }
}

async function dropSchemas(): Promise<void> {
  for (const url of [ADMIN_URL, PUBLIC_URL] as const) {
    await asSystem(url, async (tx) => {
      await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await tx.unsafe(`DELETE FROM plugin_schema_provisions WHERE schema_name = '${SCHEMA}'`);
    });
  }
}

/** index name → definition, for one table. */
async function indexes(url: string, table: string): Promise<Map<string, string>> {
  const rows = (await asSystem(url, (tx) =>
    tx.unsafe(`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = '${SCHEMA}' AND tablename = '${table}' ORDER BY indexname`),
  )) as { indexname: string; indexdef: string }[];
  return new Map(rows.map((r) => [r.indexname, r.indexdef]));
}

async function oidOf(url: string, name: string): Promise<number> {
  const rows = (await asSystem(url, (tx) =>
    tx.unsafe(`SELECT '"${SCHEMA}"."${name}"'::regclass::oid::int AS oid`),
  )) as { oid: number }[];
  return rows[0]?.oid ?? 0;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  await dropSchemas();
});

afterAll(async () => {
  await dropSchemas();
  await adapter.close();
});

const PUBLIC_TABLE = {
  entries: {
    id: "uuid",
    slug: "string",
    status: "string",
    page_id: "string",
    created_at: "timestamp",
  },
};

describe("#1292 — emitted plugin indexes", () => {
  it("cms_public: creates the declared indexes, and a new version drops only what it stopped declaring", async () => {
    const v1 = schemaFromSpec({
      tableKinds: Object.fromEntries(
        Object.keys(PUBLIC_TABLE).map((t) => [t, "visitor-state" as const]),
      ),
      pluginId: PLUGIN_ID,
      slug: SLUG,
      schema: PUBLIC_TABLE,
      indexes: {
        entries: [["slug"], ["status", "created_at"], { columns: ["page_id"], unique: true }],
      },
    });
    await adapter.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: v1.sql });
    const slugIx = pluginIndexName("entries", ["slug"], false, "");
    const statusIx = pluginIndexName("entries", ["status", "created_at"], false, "");
    const uniqueIx = pluginIndexName("entries", ["page_id"], true, "");
    const first = await indexes(PUBLIC_URL, "entries");
    expect([...first.keys()].sort()).toEqual(["entries_pkey", slugIx, statusIx, uniqueIx].sort());
    expect(first.get(uniqueIx)).toContain("CREATE UNIQUE INDEX");
    const statusOid = await oidOf(PUBLIC_URL, statusIx);

    const v2 = schemaFromSpec({
      tableKinds: Object.fromEntries(
        Object.keys(PUBLIC_TABLE).map((t) => [t, "visitor-state" as const]),
      ),
      pluginId: PLUGIN_ID,
      slug: SLUG,
      schema: PUBLIC_TABLE,
      indexes: { entries: [["status", "created_at"], ["page_id"]] },
    });
    await adapter.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: v2.sql });
    const second = await indexes(PUBLIC_URL, "entries");
    const plainPageIx = pluginIndexName("entries", ["page_id"], false, "");
    expect([...second.keys()].sort()).toEqual(["entries_pkey", plainPageIx, statusIx].sort());
    // Kept, not rebuilt.
    expect(await oidOf(PUBLIC_URL, statusIx)).toBe(statusOid);

    const v3 = schemaFromSpec({
      tableKinds: Object.fromEntries(
        Object.keys(PUBLIC_TABLE).map((t) => [t, "visitor-state" as const]),
      ),
      pluginId: PLUGIN_ID,
      slug: SLUG,
      schema: PUBLIC_TABLE,
      indexes: undefined,
    });
    await adapter.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: v3.sql });
    expect([...(await indexes(PUBLIC_URL, "entries")).keys()]).toEqual(["entries_pkey"]);
  });

  it("cms_admin: declared indexes are partial on live main-line rows; ref: and branch columns are indexed automatically", async () => {
    const adminSchema = {
      variants: { page_id: "ref:pages:cascade", group_id: "uuid", locale_code: "string" },
    };
    const emitted = adminSchemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: SLUG,
      adminSchema,
      indexes: { variants: [["group_id", "locale_code"]] },
    });
    await adapter.provisionPluginAdminSchema({ pluginId: PLUGIN_ID, sql: emitted.sql });
    const found = await indexes(ADMIN_URL, "variants");
    const declared = found.get(
      pluginIndexName("variants", ["group_id", "locale_code"], false, PRIVATE_LIVE_ROW_PREDICATE),
    );
    expect(declared).toContain("(group_id, locale_code)");
    expect(declared).toContain(
      "WHERE ((caelo_chat_branch_id IS NULL) AND (caelo_deleted_at IS NULL))",
    );
    expect(found.get(pluginIndexName("variants", ["page_id"], false, ""))).toContain("(page_id)");
    expect(
      found.get(
        pluginIndexName(
          "variants",
          ["caelo_chat_branch_id"],
          false,
          `"caelo_chat_branch_id" IS NOT NULL`,
        ),
      ),
    ).toContain("WHERE (caelo_chat_branch_id IS NOT NULL)");
    expect(found.size).toBe(4); // + the primary key

    // Dropping the declaration keeps the automatic ones.
    const bare = adminSchemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: SLUG,
      adminSchema,
      indexes: undefined,
    });
    await adapter.provisionPluginAdminSchema({ pluginId: PLUGIN_ID, sql: bare.sql });
    expect((await indexes(ADMIN_URL, "variants")).size).toBe(3);
  });
});

describe("#1292 — the list operation refuses reads no index covers", () => {
  const registry = new OperationRegistry();
  registerPluginStorageOps(registry);
  const ctx = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "plugin" as const,
    pluginId: PLUGIN_ID,
    requestId: "t1292-refusal",
  };
  const list = (filter: Record<string, unknown>) =>
    execute(registry, adapter, ctx, STORAGE_OPS.public.list, {
      schema: SCHEMA,
      table: "entries",
      columns: PUBLIC_TABLE.entries,
      filter,
    });
  const provision = async (indexes: Parameters<typeof schemaFromSpec>[0]["indexes"]) => {
    const emitted = schemaFromSpec({
      tableKinds: Object.fromEntries(
        Object.keys(PUBLIC_TABLE).map((t) => [t, "visitor-state" as const]),
      ),
      pluginId: PLUGIN_ID,
      slug: SLUG,
      schema: PUBLIC_TABLE,
      indexes,
    });
    await adapter.provisionPluginPublicSchema({ pluginId: PLUGIN_ID, sql: emitted.sql });
  };
  const messageOf = (r: Awaited<ReturnType<typeof list>>) =>
    r.ok ? "" : "message" in r.error ? String(r.error.message) : r.error.kind;

  beforeAll(() => provision({ entries: [["status", "created_at"]] }));

  it("refuses an unindexed filter with the index to declare", async () => {
    const message = messageOf(await list({ slug: "a" }));
    expect(message).toContain('no index covers this read of "entries" (it filters by slug)');
    expect(message).toContain('indexes: { schema: { entries: [["slug"]] } }');
  });

  it("refuses an unindexed order and a since/before range", async () => {
    expect(messageOf(await list({ orderBy: "page_id" }))).toContain("orders by page_id");
    expect(messageOf(await list({ since: "2026-01-01T00:00:00Z" }))).toContain(
      "orders by created_at",
    );
  });

  it("serves reads an index drives, and reads by id or with only a limit", async () => {
    expect((await list({ status: "new", orderBy: "created_at" })).ok).toBe(true);
    expect((await list({ anyOf: { status: ["new", "old"] } })).ok).toBe(true);
    expect((await list({ id: "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b" })).ok).toBe(true);
    expect((await list({ orderBy: "id", orderDir: "asc" })).ok).toBe(true);
    expect((await list({ limit: 5 })).ok).toBe(true);
  });

  it("lets a hash index drive an equality filter but not an order or IS NULL", async () => {
    await provision({ entries: [{ columns: ["slug"], method: "hash" }] });
    const def = (await indexes(PUBLIC_URL, "entries")).get(
      pluginIndexName("entries", ["slug"], false, "", "hash"),
    );
    expect(def).toContain("USING hash (slug)");
    expect((await list({ slug: "a" })).ok).toBe(true);
    expect(messageOf(await list({ orderBy: "slug" }))).toContain("orders by slug");
    // IS NULL is not `=`: a hash index cannot answer it.
    expect(messageOf(await list({ slug: null }))).toContain("filters by slug");
    await provision({ entries: [["status", "created_at"]] });
  });

  it("follows the indexes the table has, not what a caller claims", async () => {
    // The column map comes from the caller; an index cannot: a version
    // that stops declaring the index loses the read with it.
    await provision(undefined);
    expect(messageOf(await list({ status: "new" }))).toContain("filters by status");
    await provision({ entries: [["status", "created_at"]] });
    expect((await list({ status: "new" })).ok).toBe(true);
  });
});
