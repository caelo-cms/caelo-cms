// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — on request-billed CPU an admin instance confirms its plugin
 * runtime rows only when it serves a request, so its heartbeat ages while
 * it idles. Health and the Publish-live gate must read that as "idle", never
 * as "not running" (#1008: Publish live refuses while an active plugin does
 * not run, so a false "down" would block publishing):
 *
 *   - the server answering `plugins.get` counts itself however old its
 *     heartbeat is: the plugin reads `running`, not `unreported`;
 *   - another server that idled past the live window counts neither as
 *     running nor as failing; once it serves again (a fresh heartbeat) its
 *     failure counts;
 *   - the Publish-live gate (`activePluginProblems`) passes a plugin this
 *     server runs whatever its heartbeat says, ignores an idle server's
 *     failure, and still refuses a live server's.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  hostInstanceId,
  LIVE_WINDOW_MS,
  resetPluginHost,
  resetPluginHostSync,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { activePluginProblems } from "../deploy/plugin-problems.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1361-health-idle",
};
const SLUG = "t1361-idle";
const OTHER_INSTANCE = "other-revision/0b7c0d6e";
/** Older than the live window: the instance idled (or stopped) since. */
const IDLE_AGE = `${Math.ceil((LIVE_WINDOW_MS * 3) / 1000)} seconds`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  resetPluginHostSync();
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM plugin_runtime WHERE plugin_slug = ${SLUG}`;
    await tx`DELETE FROM plugin_errors WHERE plugin_slug = ${SLUG}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
  });
}

interface Health {
  state: string;
  servers: { loaded: number; failing: number };
  problem: { message: string } | null;
}

async function health(): Promise<Health> {
  const r = await execute(registry, adapter, SYSTEM, "plugins.get", { slug: SLUG });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const plugin = (r.value as { plugin: { health: Health } | null }).plugin;
  if (!plugin) throw new Error(`${SLUG} not installed`);
  return plugin.health;
}

async function gate(): Promise<{ slug: string; reason: string }[]> {
  return adapter.withAdminTransaction(SYSTEM, (tx) => activePluginProblems(tx));
}

/** Age every runtime row of `instance` past the live window, as idling without CPU does. */
async function idle(instance: string): Promise<void> {
  await sqlSystem(
    (tx) => tx`UPDATE plugin_runtime SET heartbeat_at = now() - ${IDLE_AGE}::interval
               WHERE plugin_slug = ${SLUG} AND instance_id = ${instance}`,
  );
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [
      {
        definition: definePlugin({
          slug: SLUG,
          version: "0.1.0",
          tier: 1,
          schema: {},
          operations: { noop: async () => ({}) },
        }),
      },
    ],
  });
  if (report.loaded.length !== 1) throw new Error(JSON.stringify(report));
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("#1361 — an idling server never reads as not running", () => {
  it("the server answering the health read counts itself, however long it idled", async () => {
    expect(await health()).toMatchObject({ state: "running", servers: { loaded: 1, failing: 0 } });
    await idle(hostInstanceId());
    // Before: no live row, so `unreported` ("no server reported it").
    expect(await health()).toMatchObject({ state: "running", servers: { loaded: 1, failing: 0 } });
    expect(await gate()).toEqual([]);
  });

  it("another server's failure counts while it serves, not while it idles", async () => {
    // Another server failed to load the plugin (its own error row).
    const pluginId = (
      (await sqlSystem((tx) => tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`)) as {
        id: string;
      }[]
    )[0]?.id;
    await sqlSystem(async (tx) => {
      const [error] = (await tx`
        INSERT INTO plugin_errors (plugin_slug, plugin_id, fingerprint, phase, error_class, message, last_instance)
        VALUES (${SLUG}, ${pluginId}::uuid, ${"f".repeat(64)}, 'activate', 'plugin',
                'seed row refused on the other server', ${OTHER_INSTANCE})
        RETURNING id::text AS id`) as { id: string }[];
      await tx`
        INSERT INTO plugin_runtime (instance_id, plugin_slug, state, error_id)
        VALUES (${OTHER_INSTANCE}, ${SLUG}, 'error', ${error?.id}::uuid)`;
    });
    expect(await health()).toMatchObject({ state: "failing", servers: { failing: 1 } });
    expect((await gate()).map((p) => p.slug)).toEqual([SLUG]);

    // It idles: it serves nobody, so it neither fails nor runs the plugin.
    await idle(OTHER_INSTANCE);
    expect(await health()).toMatchObject({ state: "running", servers: { loaded: 1, failing: 0 } });
    expect(await gate()).toEqual([]);

    // It serves a request again: its request start confirms its rows.
    await sqlSystem(
      (tx) => tx`UPDATE plugin_runtime SET heartbeat_at = now()
                 WHERE plugin_slug = ${SLUG} AND instance_id = ${OTHER_INSTANCE}`,
    );
    const back = await health();
    expect(back.state).toBe("failing");
    expect(back.problem?.message).toContain("other server");
    expect((await gate()).map((p) => p.slug)).toEqual([SLUG]);
  });
});
