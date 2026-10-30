// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — one plugin model: a release-signed plugin whose new release
 * asks for a capability the Owner has not approved for it stays installed
 * and active (its status is the Owner's, #1008) but does not run until the
 * Owner approves the new set. That is how international-site and
 * consent-manager reach `change_journal` on upgrade (migration 0431 keeps
 * what each plugin ran with before).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import {
  AWAITING_CAPABILITY_APPROVAL,
  bootstrap,
  loadActivatedPlugin,
  loadedPlugins,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "human", requestId: "t1267a" };
const SLUG = "t1267a-upgraded";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const plugin = definePlugin({
  slug: SLUG,
  version: "0.2.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["background_workers", "cms_admin"],
  operations: { noop: async () => ({}) },
});

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await asSystem(async (tx) => {
    await tx.unsafe(`DELETE FROM audit_events WHERE entity_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`);
    await tx.unsafe(`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`);
    await tx.unsafe(`DELETE FROM plugins WHERE slug = '${SLUG}'`);
  });
}

async function boot() {
  return bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: plugin }],
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#1267 — a new release's capabilities wait for the Owner", () => {
  it("runs what was approved, holds a release that asks for more, and runs it once approved", async () => {
    // First activation: the explicit hand-off approves exactly what it asks for.
    const first = await boot();
    expect(first.loaded.map((l) => l.slug)).toEqual([SLUG]);

    // The previous release had been approved for less (what 0431 backfills).
    resetPluginHost();
    await asSystem(
      (tx) => tx`UPDATE plugins SET approved_capabilities = ARRAY['cms_admin'] WHERE slug = ${SLUG}`,
    );
    const upgraded = await boot();
    expect(upgraded.loaded).toEqual([]);
    expect(upgraded.inactive).toEqual([
      { slug: SLUG, version: "0.2.0", status: AWAITING_CAPABILITY_APPROVAL },
    ]);
    expect(loadedPlugins.bySlug(SLUG)).toBeUndefined();

    // Still the Owner's status: active, not switched off.
    const listed = await execute(registry, adapter, OWNER, "plugins.get", { slug: SLUG });
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const row = (listed.value as { plugin: { status: string; unapprovedCapabilities: string[] } })
      .plugin;
    expect(row.status).toBe("active");
    expect(row.unapprovedCapabilities).toEqual(["background_workers"]);

    const approved = await execute(registry, adapter, OWNER, "plugins.approve_capabilities", {
      slug: SLUG,
    });
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    expect((approved.value as { approved: string[] }).approved.sort()).toEqual([
      "background_workers",
      "cms_admin",
    ]);
    expect((await loadActivatedPlugin(SLUG)).loaded).toBe(true);
    const after = await execute(registry, adapter, OWNER, "plugins.get", { slug: SLUG });
    if (!after.ok) throw new Error(JSON.stringify(after.error));
    expect(
      (after.value as { plugin: { unapprovedCapabilities: string[] } }).plugin.unapprovedCapabilities,
    ).toEqual([]);
  });

  it("refuses an AI actor and a plugin that is not installed", async () => {
    const ai = await execute(
      registry,
      adapter,
      { ...OWNER, actorKind: "ai" },
      "plugins.approve_capabilities",
      { slug: SLUG },
    );
    expect(ai.ok).toBe(false);
    if (!ai.ok) expect(ai.error.kind).toBe("ActorScopeRejected");
    const missing = await execute(registry, adapter, OWNER, "plugins.approve_capabilities", {
      slug: "t1267a-nothing",
    });
    expect(missing.ok).toBe(false);
  });
});
