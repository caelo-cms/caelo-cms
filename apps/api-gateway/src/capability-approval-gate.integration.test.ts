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
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { publishProjectionOnce, registerAdminOps } from "@caelo-cms/admin-core";
import {
  bootstrap,
  bootstrapDispatchOnly,
  registerGatewayOperations,
  resetDispatchOnlyHost,
  resetPluginHost,
  syncDispatchPlugins,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
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

let pinged = 0;
const gated = definePlugin({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: { pings: { id: "uuid" } },
  requestedCapabilities: ["snapshots"],
  publicOperations: ["ping"],
  operations: {
    ping: async () => {
      pinged += 1;
      return { pong: true };
    },
  },
});

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let savedCaptcha: { provider: string; prefix: string } | null = null;

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

function ping(): Promise<Response> {
  return handleRequest(
    new Request(`http://localhost/api/plugin/${SLUG}/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.67" },
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
  await publishProjectionOnce(adminAdapter, { declarations: new Map() });
  resetPluginHost();

  const urls = gatewayDatabaseUrls({ PUBLIC_DATABASE_URL: PUBLIC_URL });
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
  await publishProjectionOnce(adminAdapter, { declarations: new Map() });
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
    expect(pinged).toBe(0);
  });

  it("runs it once the Owner approved and the admin republished", async () => {
    await asAdmin(
      (tx) =>
        tx`UPDATE plugins SET approved_capabilities = ARRAY['snapshots'] WHERE slug = ${SLUG}`,
    );
    await publishProjectionOnce(adminAdapter, { declarations: new Map() });
    await syncDispatchPlugins({ force: true });
    const r = await ping();
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${await r.text()}`);
    expect(pinged).toBe(1);
  });

  it("detaches it again when the approval is narrowed", async () => {
    await asAdmin(
      (tx) => tx`UPDATE plugins SET approved_capabilities = '{}'::text[] WHERE slug = ${SLUG}`,
    );
    await publishProjectionOnce(adminAdapter, { declarations: new Map() });
    await syncDispatchPlugins({ force: true });
    const r = await ping();
    expect(r.status).not.toBe(200);
    expect(pinged).toBe(1);
  });
});
