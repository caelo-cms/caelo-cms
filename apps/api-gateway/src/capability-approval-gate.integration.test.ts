// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — a release-signed plugin that waits for the Owner's approval
 * of a capability (cms_admin `plugins.approved_capabilities`, migration
 * 0431) runs nothing in the API gateway either. The admin host refuses to
 * load it (loader.ts); the gateway attaches from the definition shipped in
 * its own image, so it reads the approved set from the published registry
 * (cms_public 0432) and refuses the same way.
 *
 * Adversarial: the plugin is `active` and published; only its approval is
 * missing. Its visitor-facing operation must not run. Once the Owner
 * approves (and the admin republishes), it does.
 *
 * Issue #1587 — the approval reaches the gateway with the admin's next
 * publish, not with the next Publish live. The registry follows the release
 * (#1329), but a release-signed plugin's code does not: the gateway runs the
 * one in its image, which a Caelo update replaced. Frozen, the approval named
 * the release before the update, so the live gateway refused the release
 * the Owner had approved and every visitor call of it (consent-manager's
 * `record_consent`) was a 404 until somebody published the site again.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  drainProjectionOnce,
  publishProjectionOnce,
  registerAdminOps,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "@caelo-cms/admin-core";
import {
  bootstrap,
  bootstrapDispatchOnly,
  registerGatewayOperations,
  resetDispatchOnlyHost,
  resetPluginHost,
  syncDispatchPlugins,
} from "@caelo-cms/plugin-host";
import { definePlugin, z } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { invalidateRateLimitSpecCache } from "./middleware/rate-limit.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "./server.js";
import { registerTestLiveOrigin, TEST_LIVE_ORIGIN } from "./test-support.js";

/** #1329 — the admin's adapter on the staging twin of cms_public. */
const STAGING_ADAPTER = stagingPublicAdapter(process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL ?? "");

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL, PUBLIC_ADMIN_DATABASE_URL and PUBLIC_DATABASE_URL are required",
  );
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t1267-gated";

const gated = definePlugin({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: { pings: { id: "uuid", pinged_at: "timestamp" } },
  tableKinds: { pings: "visitor-state" },
  requestedCapabilities: ["snapshots"],
  publicOperations: [
    {
      name: "ping",
      kind: "write" as const,
      captcha: "none" as const,
      input: z.looseObject({}),
      reads: ["pings"],
      writes: ["pings"],
      // #1340 — declared: one row per ping.
      run: {
        action: "insert" as const,
        table: "pings",
        values: { pinged_at: { from: "now" as const } },
        answer: { pong: true },
      },
    },
  ],
  operations: {},
});

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let savedCaptcha: { provider: string; prefix: string } | null = null;

/** Pings stored so far: each served ping is one row (#1340: the run is the operation). */
async function pinged(): Promise<number> {
  const admin = new SQL(ADMIN_URL as string);
  let pluginId: string | undefined;
  try {
    const ids = (await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`;
    })) as unknown as { id: string }[];
    pluginId = ids[0]?.id;
  } finally {
    await admin.end();
  }
  if (!pluginId) return 0;
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    const rows = (await pub.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`SELECT set_config('caelo.plugin_id', ${pluginId}, true)`;
      return tx.unsafe(`SELECT count(*)::int AS n FROM "plugin_t1267_gated".pings`);
    })) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  } catch (e) {
    // Before the plugin's schema exists nothing was pinged.
    if (/does not exist/.test(String(e))) return 0;
    throw e;
  } finally {
    await pub.end();
  }
}

async function asAdmin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  resetDispatchOnlyHost();
  await asAdmin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "plugin_t1267_gated" CASCADE`);
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
  });
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS "plugin_t1267_gated" CASCADE`);
  } finally {
    await pub.end();
  }
}

/** The release state the live database is pointed at (only Publish live moves it). */
async function livePointer(): Promise<string | null> {
  return asAdmin(async (tx) => {
    const [row] = (await tx`
      SELECT run_id::text AS id FROM projection_release_pointers WHERE environment = 'live'`) as {
      id: string;
    }[];
    return row?.id ?? null;
  });
}

function ping(): Promise<Response> {
  return handleRequest(
    new Request(`http://localhost/api/plugin/${SLUG}/ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_LIVE_ORIGIN,
        "X-Forwarded-For": "192.0.2.67",
      },
      body: "{}",
    }),
  );
}

beforeAll(async () => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "1";
  await cleanup();
  savedCaptcha = await asAdmin(async (tx) => {
    const [row] =
      (await tx`SELECT captcha_provider AS provider, captcha_pow_target_prefix AS prefix FROM site_settings WHERE id = 1`) as {
        provider: string;
        prefix: string;
      }[];
    return row ?? null;
  });
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const adminRegistry = new OperationRegistry();
  registerAdminOps(adminRegistry);
  const adminReport = await bootstrap({
    infra: { adapter: adminAdapter, registry: adminRegistry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: gated }],
  });
  expect(adminReport.failed).toEqual([]);
  // A new release asks for a capability the Owner has not approved: the
  // plugin stays active, its approved set lacks `snapshots`.
  await asAdmin(async (tx) => {
    await tx`UPDATE plugins SET approved_capabilities = '{}'::text[] WHERE slug = ${SLUG}`;
    await tx`UPDATE site_settings SET captcha_provider = 'off' WHERE id = 1`;
  });
  await registerTestLiveOrigin(ADMIN_URL as string);
  // #1329 — the registry follows the release: published once released.
  await releaseProjectionForTests(adminAdapter, STAGING_ADAPTER);
  resetPluginHost();

  const urls = gatewayDatabaseUrls({
    PUBLIC_DATABASE_URL: PUBLIC_URL,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  });
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  const registry = new OperationRegistry();
  registerGatewayOperations(registry);
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  invalidateRateLimitSpecCache();
  const report = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: gated }],
  });
  expect(report.failed).toEqual([]);
});

afterAll(async () => {
  await asAdmin(async (tx) => {
    await tx`UPDATE site_settings SET captcha_provider = ${savedCaptcha?.provider ?? "pow"},
             captcha_pow_target_prefix = ${savedCaptcha?.prefix ?? "000fff"} WHERE id = 1`;
  });
  await cleanup();
  await publishProjectionOnce(adminAdapter, STAGING_ADAPTER, { declarations: new Map() });
  await gatewayAdapter.close();
  await adminAdapter.close();
});

describe("#1267 — the gateway honours the capability approval gate", () => {
  it("publishes the approved set with the registry", async () => {
    const pub = new SQL(PUBLIC_ADMIN_URL as string);
    try {
      const rows = (await pub.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`SELECT approved_capabilities FROM published_plugins WHERE slug = ${SLUG}`;
      })) as { approved_capabilities: string[] | null }[];
      expect(rows.map((r) => [...(r.approved_capabilities ?? ["<null>"])])).toEqual([[]]);
    } finally {
      await pub.end();
    }
  });

  it("runs no visitor-facing operation of a plugin waiting for approval", async () => {
    const r = await ping();
    expect(r.status).not.toBe(200);
    expect(await pinged()).toBe(0);
  });

  it("runs it once the Owner approved and the admin republished, without a Publish live", async () => {
    const pointer = await livePointer();
    await asAdmin(
      (tx) =>
        tx`UPDATE plugins SET approved_capabilities = ARRAY['snapshots'] WHERE slug = ${SLUG}`,
    );
    // #1587 — the admin's post-write drain, not a release: the approval of a
    // release-signed plugin is published as the Owner holds it now.
    await drainProjectionOnce(adminAdapter, STAGING_ADAPTER);
    expect(await livePointer()).toBe(pointer);
    await syncDispatchPlugins({ force: true });
    const r = await ping();
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${await r.text()}`);
    expect(await pinged()).toBe(1);
  });

  it("detaches it again when the approval is narrowed", async () => {
    await asAdmin(
      (tx) => tx`UPDATE plugins SET approved_capabilities = '{}'::text[] WHERE slug = ${SLUG}`,
    );
    // #1329 — a narrowed approval reaches the live database at once.
    await publishProjectionOnce(adminAdapter, STAGING_ADAPTER, { declarations: new Map() });
    await syncDispatchPlugins({ force: true });
    const r = await ping();
    expect(r.status).not.toBe(200);
    expect(await pinged()).toBe(1);
  });
});

describe("#1587 — a release approved after a Caelo update runs on the live gateway", () => {
  it("serves its visitor operation from the approval, not from the last Publish live", async () => {
    // What the Owner approves for the release this gateway runs.
    const approvedNow = await asAdmin(async (tx) => {
      const [row] = (await tx`
        SELECT approved_manifest_digest AS digest FROM plugins WHERE slug = ${SLUG}`) as {
        digest: string | null;
      }[];
      return row?.digest ?? null;
    });
    expect(approvedNow).toMatch(/^[0-9a-f]{64}$/);

    // The site went live before the update: the last Publish live froze the
    // approval of the release before it, whose manifest differs.
    await asAdmin(
      (tx) =>
        tx`UPDATE plugins SET approved_capabilities = ARRAY['snapshots'],
                              approved_manifest_digest = ${"0".repeat(64)}
           WHERE slug = ${SLUG}`,
    );
    await releaseProjectionForTests(adminAdapter, STAGING_ADAPTER, new Map([[SLUG, null]]));
    await syncDispatchPlugins({ force: true });
    // The update rolled the gateway: the release in its image is not approved yet.
    expect((await ping()).status).toBe(404);
    const before = await pinged();
    const pointer = await livePointer();

    // The Owner approves the updated release. Nothing is staged or published.
    await asAdmin(
      (tx) => tx`UPDATE plugins SET approved_manifest_digest = ${approvedNow} WHERE slug = ${SLUG}`,
    );
    await drainProjectionOnce(adminAdapter, STAGING_ADAPTER);
    expect(await livePointer()).toBe(pointer);
    await syncDispatchPlugins({ force: true });
    const r = await ping();
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${await r.text()}`);
    expect(await pinged()).toBe(before + 1);
  });
});
