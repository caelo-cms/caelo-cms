// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { definePlugin, type PluginContextTier1, type PluginQuery } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { makePluginContext } from "./capabilities.js";
import { bootstrap, loadedPlugins, resetPluginHost } from "./index.js";

const actorId = "00000000-0000-0000-0000-00000000ffff";
const schema = { state: { id: "uuid", revision: "text", payload: "jsonb", note: "text" } };
let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
const handles = new Map<string, PluginQuery>();
const names = ["cas-public-a", "cas-public-b", "cas-private-a", "cas-private-b"];

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

for (const pool of ["public", "private"]) {
  describe(`atomic conditional writes in ${pool} plugin storage`, () => {
    it("allows exactly one concurrent revision change and persists the winning JSON value", async () => {
      const query = handles.get(`cas-${pool}-a`)!;
      const row = await query.insert("state", {
        revision: "base",
        payload: ["original"],
        note: null,
      });
      const won = await Promise.all(
        ["left", "right"].map((revision) =>
          query.compareAndSwap(
            "state",
            row.id,
            { revision: "base", note: null },
            { revision, payload: [revision, { complete: true }] },
          ),
        ),
      );
      expect(won.filter(Boolean)).toHaveLength(1);
      const current = (await query.list("state", { id: row.id }))[0]!;
      expect(current.payload).toEqual([current.revision, { complete: true }]);
      expect(
        await query.compareAndSwap("state", row.id, { revision: "base" }, { revision: "lost" }),
      ).toBe(false);
    });
    it("honors JSON equality and null while rejecting identity and undeclared writes", async () => {
      const query = handles.get(`cas-${pool}-a`)!;
      const row = await query.insert("state", {
        revision: "base",
        payload: { a: 1, b: 2 },
        note: null,
      });
      expect(
        await query.compareAndSwap(
          "state",
          row.id,
          { payload: { b: 2, a: 1 } },
          { payload: ["new"] },
        ),
      ).toBe(true);
      await expect(query.compareAndSwap("state", row.id, {}, { note: "x" })).rejects.toThrow(
        "1..64",
      );
      await expect(
        query.compareAndSwap("state", row.id, { note: null }, { id: crypto.randomUUID() }),
      ).rejects.toThrow("immutable");
      await expect(
        query.compareAndSwap("state", row.id, { note: null }, { caelo_plugin_id: actorId }),
      ).rejects.toThrow("immutable");
      await expect(
        query.compareAndSwap("state", row.id, { note: null }, { note: undefined }),
      ).rejects.toThrow("undefined");
    });
    it("does not update another plugin's storage, including with a mismatched host identity", async () => {
      const query = handles.get(`cas-${pool}-a`)!;
      const row = await query.insert("state", { revision: "base" });
      expect(
        await handles
          .get(`cas-${pool}-b`)!
          .compareAndSwap("state", row.id, { revision: "base" }, { revision: "stolen" }),
      ).toBe(false);
      const a = loadedPlugins.bySlug(`cas-${pool}-a`)!;
      const b = loadedPlugins.bySlug(`cas-${pool}-b`)!;
      const context = (await makePluginContext({
        plugin: { ...a, pluginId: b.pluginId, pluginActorId: b.pluginActorId },
        infra: { adapter, registry },
      })) as PluginContextTier1;
      const mismatched = pool === "private" ? context.adminQuery! : context.query;
      expect(
        await mismatched.compareAndSwap(
          "state",
          row.id,
          { revision: "base" },
          { revision: "stolen" },
        ),
      ).toBe(false);
    });
  });
}
