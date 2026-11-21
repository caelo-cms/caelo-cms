// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1669 — a plugin `list` reads its table's index leads from the
 * catalog once per loaded plugin, not on every call. A new load of the
 * plugin (an admin's reload after provisioning, the gateway attaching a
 * new version) registers a new `LoadedPlugin` and reads them again, so an
 * index a new version adds is seen without a restart.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { definePlugin, type PluginContextTier1, type PluginQuery } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { makePluginContext } from "./capabilities.js";
import { bootstrap, loadedPlugins, resetPluginHost } from "./index.js";

const actorId = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t1669-leads";
const statements: string[] = [];
let adapter: DatabaseAdapter;
const registry = new OperationRegistry();

const catalogReads = () => statements.filter((s) => s.includes("FROM pg_catalog.pg_index")).length;

/** The plugin's private-storage query handle, through the plugin as loaded now. */
async function query(): Promise<PluginQuery> {
  const plugin = loadedPlugins.bySlug(SLUG);
  if (!plugin) throw new Error(`Not loaded: ${SLUG}`);
  const context = (await makePluginContext({
    plugin,
    infra: { adapter, registry },
    invocation: { origin: "system", actorId },
  })) as PluginContextTier1;
  if (!context.adminQuery) throw new Error("no adminQuery");
  return context.adminQuery;
}

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    onStatement: (s) => statements.push(s),
  });
  const result = await bootstrap({
    infra: { adapter, registry },
    systemActorId: actorId,
    pluginsRoot: "/unused",
    testPlugins: [
      {
        definition: definePlugin<PluginContextTier1>({
          slug: SLUG,
          tier: 1,
          version: "1.0.0",
          schema: {},
          adminSchema: { items: { id: "uuid", status: "text" } },
          indexes: { adminSchema: { items: [["status"]] } },
          requestedCapabilities: ["cms_admin_schema"],
          operations: { probe: async () => true },
        }),
      },
    ],
  });
  expect(result.failed).toEqual([]);
});

afterAll(async () => {
  resetPluginHost();
  await adapter.close();
});

describe("#1669 — index leads per loaded plugin", () => {
  it("reads the catalog once for many lists, and again after a new load", async () => {
    const q = await query();
    statements.length = 0;
    for (const status of ["new", "old", "new"]) {
      expect(await q.list("items", { status })).toEqual([]);
    }
    expect(catalogReads()).toBe(1);

    // A new load registers a new LoadedPlugin (the gateway's attach does
    // exactly this); its first list reads the catalog again.
    const loaded = loadedPlugins.bySlug(SLUG);
    if (!loaded) throw new Error("not loaded");
    loadedPlugins.set({ ...loaded });
    const reloaded = await query();
    statements.length = 0;
    expect(await reloaded.list("items", { status: "new" })).toEqual([]);
    expect(await reloaded.list("items", { status: "old" })).toEqual([]);
    expect(catalogReads()).toBe(1);
  });
});
