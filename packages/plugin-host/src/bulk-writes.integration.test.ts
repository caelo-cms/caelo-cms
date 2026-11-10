// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1391 — `updateMany`: one patch on many rows of a plugin's own
 * table, in both zones. Every row or none, one change (in the private
 * zone one snapshot header for all rows), and the same refusals as a
 * single `update`. Another plugin's rows are out of reach (RLS).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { definePlugin, type PluginContextTier1, type PluginQuery } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { makePluginContext } from "./capabilities.js";
import { bootstrap, loadedPlugins, resetPluginHost } from "./index.js";

const actorId = "00000000-0000-0000-0000-00000000ffff";
const schema = { items: { id: "uuid", status: "text", note: "text" } };
let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
const handles = new Map<string, PluginQuery>();
const names = ["bulk-public-a", "bulk-public-b", "bulk-private-a", "bulk-private-b"];

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  const definitions = names.map((slug) =>
    definePlugin<PluginContextTier1>({
      slug,
      tier: 1,
      version: "1.0.0",
      schema: slug.includes("public") ? schema : {},
      tableKinds: slug.includes("public") ? { items: "visitor-state" as const } : {},
      ...(slug.includes("private")
        ? { adminSchema: schema, requestedCapabilities: ["cms_admin_schema" as const] }
        : {}),
      operations: { probe: async () => true },
    }),
  );
  const result = await bootstrap({
    infra: { adapter, registry },
    systemActorId: actorId,
    pluginsRoot: "/unused",
    testPlugins: definitions.map((definition) => ({ definition })),
  });
  expect(result.failed).toEqual([]);
  for (const name of names) {
    const plugin = loadedPlugins.bySlug(name);
    if (!plugin) throw new Error(`Not loaded: ${name}`);
    const context = (await makePluginContext({
      plugin,
      infra: { adapter, registry },
      invocation: { origin: "system", actorId },
    })) as PluginContextTier1;
    const query = name.includes("private") ? context.adminQuery : context.query;
    if (!query) throw new Error(`No query for ${name}`);
    handles.set(name, query);
  }
});
afterAll(async () => {
  resetPluginHost();
  await adapter.close();
});

async function seed(query: PluginQuery, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push((await query.insert("items", { status: "fresh" })).id);
  return ids;
}

async function statusOf(query: PluginQuery, ids: readonly string[]): Promise<unknown[]> {
  const rows = await query.list("items", { anyOf: { id: [...ids] }, limit: 1000 });
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  return ids.map((id) => byId.get(id));
}

for (const pool of ["public", "private"]) {
  describe(`updateMany in ${pool} plugin storage (#1391)`, () => {
    it("sets the patch on every listed row and on no other", async () => {
      const query = handles.get(`bulk-${pool}-a`)!;
      const ids = await seed(query, 5);
      // Upper case and a duplicate name the same rows.
      const listed = [ids[0]!.toUpperCase(), ids[1]!, ids[2]!, ids[2]!];
      await query.updateMany("items", listed, { status: "stale", note: "bulk" });
      expect(await statusOf(query, ids)).toEqual(["stale", "stale", "stale", "fresh", "fresh"]);
      await query.updateMany("items", [], { status: "never" });
      expect(await statusOf(query, ids)).toEqual(["stale", "stale", "stale", "fresh", "fresh"]);
    });

    it("updates no row when one listed row is missing, and names it", async () => {
      const query = handles.get(`bulk-${pool}-a`)!;
      const ids = await seed(query, 3);
      const missing = crypto.randomUUID();
      await expect(
        query.updateMany("items", [...ids, missing], { status: "stale" }),
      ).rejects.toThrow(missing);
      expect(await statusOf(query, ids)).toEqual(["fresh", "fresh", "fresh"]);
    });

    it("refuses what a single update refuses, and more than 1000 ids", async () => {
      const query = handles.get(`bulk-${pool}-a`)!;
      const ids = await seed(query, 1);
      await expect(query.updateMany("items", ids, { caelo_version: 9 })).rejects.toThrow();
      await expect(query.updateMany("items", ids, { undeclared: 1 })).rejects.toThrow(
        "not declared",
      );
      await expect(query.updateMany("items", ids, { id: crypto.randomUUID() })).rejects.toThrow(
        "at least one declared column",
      );
      await expect(query.updateMany("items", ids, { status: undefined })).rejects.toThrow(
        "undefined",
      );
      const many = Array.from({ length: 1001 }, () => crypto.randomUUID());
      await expect(query.updateMany("items", many, { status: "x" })).rejects.toThrow("1000");
      expect(await statusOf(query, ids)).toEqual(["fresh"]);
    });

    it("cannot reach another plugin's rows", async () => {
      const own = handles.get(`bulk-${pool}-a`)!;
      const ids = await seed(own, 2);
      await expect(
        handles.get(`bulk-${pool}-b`)!.updateMany("items", ids, { status: "stolen" }),
      ).rejects.toThrow("not found");
      expect(await statusOf(own, ids)).toEqual(["fresh", "fresh"]);
    });
  });
}

describe("updateMany in private storage on main (#1391)", () => {
  it("records one snapshot header for all rows, each row's new state and version", async () => {
    const query = handles.get("bulk-private-a")!;
    const ids = await seed(query, 4);
    await query.updateMany("items", ids, { status: "stale" });
    const sql = new SQL(process.env.ADMIN_DATABASE_URL!);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`
          SELECT prs.site_snapshot_id::text AS header, prs.state, h.op_kind, h.chat_branch_id
          FROM plugin_row_snapshots prs JOIN site_snapshots h ON h.id = prs.site_snapshot_id
          WHERE prs.row_id = ANY(${ids}::uuid[]) AND prs.state->'values'->>'status' = 'stale'
        `;
      })) as {
        header: string;
        state: { values: { status: string }; version: number };
        op_kind: string;
        chat_branch_id: string | null;
      }[];
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.header)).size).toBe(1);
      expect(rows.every((r) => r.op_kind === "plugin_storage.update")).toBe(true);
      expect(rows.every((r) => r.chat_branch_id === null)).toBe(true);
      // The insert was version 1; the bulk write made it 2.
      expect(rows.map((r) => r.state.version)).toEqual([2, 2, 2, 2]);
    } finally {
      await sql.end();
    }
  });
});
