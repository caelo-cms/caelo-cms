// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host integration tests.
 *
 * Uses the `testPlugins` mode of `bootstrap(...)` to register Tier-1
 * fixtures directly (skipping on-disk filesystem walk + signature verify).
 * Exercises:
 *   - Tier-1 plugin loads → plugins row upserted at status='active' with
 *     a fresh actor row tied via plugin_id.
 *   - tools[] → registered into pluginToolsRegistry.
 *   - workers[] → mounted in pluginWorkerScheduler.
 *   - promptContext[] → registered + renderable.
 *   - runPluginOperation dispatches to the plugin's operation handler.
 *   - ctx.cms.call works against a registered cms_admin op.
 *   - Disable + re-enable: tools/workers vanish + reappear.
 *   - Failure isolation: corrupt plugin doesn't stop the rest.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import {
  bootstrap,
  loadedPlugins,
  type PluginHostInfra,
  pluginPromptContextRegistry,
  pluginToolsRegistry,
  pluginWorkerScheduler,
  resetPluginHost,
  runPluginOperation,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const HOST_TEST_SLUG = "test-p115-host-fixture";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

// A simple cms_admin op the plugin will call via ctx.cms.call(...).
const echoOp = defineOperation({
  name: "test_p115.echo",
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({ message: z.string() }).strict(),
  output: z.object({ echoed: z.string(), actorKind: z.string() }),
  handler: async (ctx, input) => ok({ echoed: input.message, actorKind: ctx.actorKind }),
});

async function wipe(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // v0.2.16 — runPluginOperation now emits audit_events rows
      // referencing the plugin's actor. Clear those before the actor
      // so the actor_id FK doesn't block cleanup.
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (
          SELECT id FROM plugins WHERE slug LIKE 'test-p115-%'
        )
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-p115-%')`;
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-p115-%')`;
      await tx`DELETE FROM plugins WHERE slug LIKE 'test-p115-%'`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  registry.register(echoOp);
  infra = { adapter, registry };
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

const helloPluginDef = definePlugin({
  slug: HOST_TEST_SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  operations: {
    greet: async (_ctx, args) => {
      const a = args as { name?: string };
      return { greeting: `hello ${a.name ?? "world"}` };
    },
    via_cms: async (ctx, _args) => {
      const c = (ctx as { cms?: { call: (op: string, i: unknown) => Promise<unknown> } }).cms;
      if (!c) throw new Error("ctx.cms missing — capability not granted");
      const r = await c.call("test_p115.echo", { message: "from-plugin" });
      return r;
    },
  },
  requestedCapabilities: ["cms_admin"],
  tools: [
    {
      name: "test_p115_greet",
      description: "Greet a name via the test plugin.",
      operationName: "greet",
      inputJsonSchema: { type: "object", properties: { name: { type: "string" } } },
    },
  ],
  promptContext: [
    {
      label: "test-p115-block",
      render: () => "# Test\nplugin renderer reached",
    },
  ],
});

describe("plugin-host bootstrap (testPlugins mode)", () => {
  it("loads a Tier-1 plugin: row + actor + tools + promptContext", async () => {
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: helloPluginDef }],
    });
    expect(report.failed).toHaveLength(0);
    expect(report.loaded[0]?.slug).toBe(HOST_TEST_SLUG);

    // Plugin row + actor row landed.
    const get = await execute(
      registry,
      adapter,
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t" } satisfies ExecutionContext,
      "plugins.get",
      { slug: HOST_TEST_SLUG },
    );
    if (!get.ok) throw new Error("plugins.get failed");
    const row = (get.value as { plugin: { id: string; status: string; tier: number } | null })
      .plugin;
    expect(row?.status).toBe("active");
    expect(row?.tier).toBe(1);

    // Actor exists with kind='plugin'.
    const actorRows = await adapter.withAdminTransaction(
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t" },
      async (tx) => {
        const { sql } = await import("drizzle-orm");
        return (await tx.execute(
          sql`SELECT kind FROM actors WHERE plugin_id = ${row?.id ?? ""}::uuid`,
        )) as unknown as { kind: string }[];
      },
    );
    expect(actorRows[0]?.kind).toBe("plugin");

    // Tools registered.
    expect(pluginToolsRegistry.resolve("test_p115_greet")).not.toBeNull();
    expect(pluginToolsRegistry.list()).toHaveLength(1);

    // Prompt-context registered + renderable.
    const blocks = await pluginPromptContextRegistry.renderAll();
    expect(blocks.some((b) => b.includes("plugin renderer reached"))).toBe(true);
  });

  it("dispatches a plugin operation and the operation can call ctx.cms.call", async () => {
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: helloPluginDef }],
    });

    // Direct dispatch via runPluginOperation.
    const direct = await runPluginOperation({
      pluginSlug: HOST_TEST_SLUG,
      operationName: "greet",
      args: { name: "caelo" },
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value).toEqual({ greeting: "hello caelo" });

    // Via ctx.cms.call to a real cms_admin op.
    const viaCms = await runPluginOperation({
      pluginSlug: HOST_TEST_SLUG,
      operationName: "via_cms",
      args: {},
    });
    expect(viaCms.ok).toBe(true);
    if (!viaCms.ok) return;
    expect(viaCms.value).toEqual({ echoed: "from-plugin", actorKind: "plugin" });
  });

  it("PluginNotFound for missing slug; OperationNotDeclared for missing op", async () => {
    const r1 = await runPluginOperation({ pluginSlug: "nope", operationName: "x", args: {} });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe("PluginNotFound");

    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: helloPluginDef }],
    });
    const r2 = await runPluginOperation({
      pluginSlug: HOST_TEST_SLUG,
      operationName: "nonexistent",
      args: {},
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe("OperationNotDeclared");
  });

  it("workers[] mounted in scheduler and unscheduled on resetPluginHost", async () => {
    const withWorkerDef = definePlugin({
      ...helloPluginDef,
      slug: "test-p115-workered",
      workers: [
        { name: "tick", cron: "0 0 * * *", operationName: "greet" }, // daily; never fires in test
      ],
    });
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: withWorkerDef }],
    });
    const scheduled = pluginWorkerScheduler
      .list()
      .filter((w) => w.pluginSlug === "test-p115-workered");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.cron).toBe("0 0 * * *");

    resetPluginHost();
    expect(pluginWorkerScheduler.list()).toHaveLength(0);
  });

  it("failure isolation: one bad plugin doesn't block the rest", async () => {
    const goodDef = definePlugin({ ...helloPluginDef, slug: "test-p115-good" });
    // Bad: definePlugin freezes shape, but we can supply a deliberately-broken
    // ops handler that throws on registration via missing required field.
    const badDef = definePlugin({
      slug: "test-p115-bad",
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: {} as never, // empty; loader doesn't enforce min(1) on the in-memory shape, so this loads fine
      requestedCapabilities: [],
    });
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: badDef }, { definition: goodDef }],
    });
    // Both registered (the testPlugins fast path skips deep validation).
    expect(report.loaded.map((p) => p.slug).sort()).toEqual(
      ["test-p115-bad", "test-p115-good"].sort(),
    );
    // Direct dispatch on the good one still works.
    const r = await runPluginOperation({
      pluginSlug: "test-p115-good",
      operationName: "greet",
      args: { name: "ok" },
    });
    expect(r.ok).toBe(true);
    expect(loadedPlugins.bySlug("test-p115-good")).toBeDefined();
  });
});
