// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #856 — public_role may record a plugin op event in
 * `cms_public.gateway_plugin_op_events` only for a plugin the admin
 * published as active, and only under that plugin's own slug.
 *
 * Before cms_public migration 0300 the gateway's INSERT policy was
 * `WITH CHECK (true)`: any well-formed row went in, so a compromised public
 * side could attribute events to plugins that are not installed, not active,
 * or not the plugin that ran the op. The rows stay UNTRUSTED hints for the
 * redeploy orchestrator either way (#844 drops invalid ones); this is the
 * Postgres half of that defense (CLAUDE.md §2).
 *
 * Production wiring, like public-gateway.integration.test.ts: an admin-side
 * host registers the real ratings plugin (with consent-manager, which it
 * requires) plus a fixture that is then
 * disabled, the admin publishes the projection, and the gateway serves
 * /api/* as public_role through the dispatch-only host. The adversarial
 * inserts go straight at the table as public_role, the way a compromised
 * gateway would.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { publishProjectionOnce } from "@caelo-cms/admin-core";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import {
  bootstrap,
  bootstrapDispatchOnly,
  registerGatewayOperations,
  resetDispatchOnlyHost,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import ratingsPlugin from "@caelo-cms/plugin-ratings";
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
/** A Tier 1 fixture that is installed, then disabled before the publish. */
const OFF_SLUG = "t856-off";
// Ratings requires consent-manager (its visitor-id purpose needs a
// consent provider), so the real pair is installed.
const SLUGS = ["consent-manager", "ratings", OFF_SLUG] as const;
const UNKNOWN_PLUGIN_ID = "85600000-0000-4000-8000-000000000001";
const HASH = "d".repeat(64);

const offFixture = definePlugin({
  slug: OFF_SLUG,
  version: "1.0.0",
  tier: 1,
  schema: { pings: { id: "uuid" } },
  publicOperations: ["ping"],
  operations: {
    ping: async () => ({ pong: true }),
  },
});

/** Consent-manager's declared projection, which the gateway's consent rule reads. */
const DECLARATIONS = new Map([["consent-manager", consentPlugin.visitorProjection ?? {}]]);

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let gateway: SQL;
let pluginIds: Record<string, string> = {};
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

/** Read cms_public as the admin (admin_role, system actor). */
async function asPublicAdmin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(PUBLIC_ADMIN_URL as string);
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
    for (const slug of SLUGS) {
      await tx.unsafe(`DROP SCHEMA IF EXISTS "plugin_${slug.replace(/-/g, "_")}" CASCADE`);
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug}))`;
      await tx`DELETE FROM site_snapshots WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
      await tx`DELETE FROM plugins WHERE slug = ${slug}`;
    }
  });
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    for (const slug of SLUGS) {
      await pub.unsafe(`DROP SCHEMA IF EXISTS "plugin_${slug.replace(/-/g, "_")}" CASCADE`);
    }
  } finally {
    await pub.end();
  }
}

/** One op event inserted as public_role; "ok" or the error Postgres raised. */
async function gatewayInsert(pluginId: string, operation: string): Promise<string> {
  try {
    await gateway`
      INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, entity_id)
      VALUES (${pluginId}::uuid, ${operation}, ${HASH}, true, NULL)`;
    return "ok";
  } catch (e) {
    const err = e as { message?: string };
    return err.message ?? String(e);
  }
}

const RLS_REJECTED = /row-level security policy/;

async function expectStatus(r: Response, status: number): Promise<void> {
  if (r.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${r.status}: ${await r.clone().text()}`);
  }
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

  // --- Admin side: register + provision both plugins, disable the fixture,
  // then publish: the projection carries ratings only. Ratings asks for a
  // captcha proof; the proof path has its own tests. ---
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const adminReport = await bootstrap({
    infra: { adapter: adminAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [
      { definition: consentPlugin },
      { definition: ratingsPlugin },
      { definition: offFixture },
    ],
  });
  expect(adminReport.failed).toEqual([]);
  pluginIds = await asAdmin(async (tx) => {
    await tx`UPDATE plugins SET status = 'disabled' WHERE slug = ${OFF_SLUG}`;
    await tx`UPDATE site_settings SET captcha_provider = 'off' WHERE id = 1`;
    const rows = (await tx`SELECT slug, id::text AS id FROM plugins
                           WHERE slug IN ('ratings', ${OFF_SLUG})`) as {
      slug: string;
      id: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.slug, r.id]));
  });
  await publishProjectionOnce(adminAdapter, { declarations: DECLARATIONS });
  resetPluginHost();

  // --- Gateway side: its real identity, dispatch-only host. ---
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
    testPlugins: [
      { definition: consentPlugin },
      { definition: ratingsPlugin },
      { definition: offFixture },
    ],
  });
  expect(report.failed).toEqual([]);
  gateway = new SQL(PUBLIC_URL as string);
});

afterAll(async () => {
  await gateway.end();
  await asAdmin(async (tx) => {
    await tx`UPDATE site_settings SET captcha_provider = ${savedCaptcha?.provider ?? "pow"},
             captcha_pow_target_prefix = ${savedCaptcha?.prefix ?? "000fff"} WHERE id = 1`;
  });
  await cleanup();
  await publishProjectionOnce(adminAdapter, { declarations: DECLARATIONS });
  await gatewayAdapter.close();
  await adminAdapter.close();
});

describe("public_role op events are tied to published plugins (#856)", () => {
  it("the projection carries ratings and not the disabled fixture", async () => {
    const published = await asPublicAdmin(
      async (tx) =>
        (await tx`SELECT slug FROM published_plugins WHERE slug IN ('ratings', ${OFF_SLUG})`) as {
          slug: string;
        }[],
    );
    expect(published.map((p) => p.slug)).toEqual(["ratings"]);
  });

  it("rejects an event for a plugin id that was never published", async () => {
    expect(await gatewayInsert(UNKNOWN_PLUGIN_ID, "ratings.submit")).toMatch(RLS_REJECTED);
  });

  it("rejects an event for an installed plugin that is not active", async () => {
    const offId = pluginIds[OFF_SLUG] as string;
    expect(offId).toBeTruthy();
    expect(await gatewayInsert(offId, `${OFF_SLUG}.ping`)).toMatch(RLS_REJECTED);
  });

  it("rejects an event whose operation names another plugin's slug", async () => {
    const ratingsId = pluginIds.ratings as string;
    expect(await gatewayInsert(ratingsId, "comments.moderate")).toMatch(RLS_REJECTED);
    // A slug that merely starts with the published one is not it.
    expect(await gatewayInsert(ratingsId, "ratings-x.submit")).toMatch(RLS_REJECTED);
    // The disabled fixture's id cannot borrow an active plugin's slug either.
    expect(await gatewayInsert(pluginIds[OFF_SLUG] as string, "ratings.submit")).toMatch(
      RLS_REJECTED,
    );
  });

  it("accepts an event of an active published plugin under its own slug", async () => {
    expect(await gatewayInsert(pluginIds.ratings as string, "ratings.submit")).toBe("ok");
  });

  it("the real gateway dispatch still records a shipped plugin's event", async () => {
    const r = await handleRequest(
      new Request("http://localhost/api/plugin/ratings/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.86" },
        body: JSON.stringify({ pageId: "p-856", score: 4 }),
      }),
    );
    await expectStatus(r, 200);
    const { data } = (await r.json()) as { data: { id: string } };
    const events = await asPublicAdmin(
      async (tx) =>
        (await tx`SELECT operation, entity_id::text AS entity_id, succeeded
                  FROM gateway_plugin_op_events
                  WHERE plugin_id = ${pluginIds.ratings as string}::uuid AND entity_id IS NOT NULL`) as {
          operation: string;
          entity_id: string;
          succeeded: boolean;
        }[],
    );
    expect(events).toContainEqual({
      operation: "ratings.submit",
      entity_id: data.id,
      succeeded: true,
    });
  });
});
