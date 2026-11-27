// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the gateway half of `email` for a runtime-installed plugin
 * (docs/dev/external-plugin-brokers.md §7.3). The admin stages, approves
 * and activates an installed plugin that declares core's double opt-in and
 * publishes it; the gateway, with its real identity (public_role, no
 * cms_admin pool), attaches it from what the admin published and serves a
 * visitor's sign-up through `handleRequest`. The declared block queues the
 * plugin's reviewed template into the live outbox; no plugin code runs on
 * the gateway, and the handle it gets has no free-form send. The plugin
 * also holds a `cms_admin` grant: the gateway reads grants without their
 * constraints, and attaches it all the same (no installed plugin's code
 * calls core there).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerAdminOps,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "@caelo-cms/admin-core";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  bootstrapDispatchOnly,
  loadedPlugins,
  resetDispatchOnlyHost,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { invalidateRateLimitSpecCache } from "./middleware/rate-limit.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  gatewayMailLinks,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "./server.js";
import { registerTestLiveOrigin, TEST_LIVE_ORIGIN } from "./test-support.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL || !STAGING_ADMIN_URL) {
  throw new Error("the admin, public and staging database URLs are required");
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t1729-letter";
const SCHEMA = "plugin_t1729_letter";
const system = { actorId: SYSTEM_ACTOR_ID, actorKind: "system" as const, requestId: "t1729-gw" };

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {
    subscribers: {
      id: "uuid",
      email: "string",
      email_hash: "string",
      confirm_token: "string",
      confirm_expires_at: "timestamp_nullable",
      confirmed_at: "timestamp_nullable",
      unsub_token: "string",
      created_at: "timestamp",
    },
  },
  tableKinds: { subscribers: "visitor-state" },
  indexes: { schema: { subscribers: [["email_hash"], ["confirm_token"]] } },
  requires: ["email"],
  requestedCapabilities: ["email", "cms_admin"],
  capabilityReasons: { email: "Confirm sign-ups", cms_admin: "Read the pages it lists" },
  capabilityConstraints: { cms_admin: { operations: ["pages.list"] } },
  mailTemplates: {
    confirm_it: {
      subject: "Confirm your sign-up",
      body: ["Please confirm."],
      link: { operation: "confirm", label: "Confirm", done: "Confirmed." },
    },
  },
  publicOperations: [
    {
      name: "subscribe",
      kind: "write",
      captcha: "none",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["email"],
        properties: {
          email: { type: "string", maxLength: 254, format: "email" },
          hp_address: { type: "string", maxLength: 500 },
        },
      },
      reads: ["subscribers"],
      writes: ["subscribers"],
      run: {
        action: "block",
        block: "double-opt-in.subscribe",
        options: { table: "subscribers", template: "confirm_it", hours: 48 },
      },
    },
    {
      name: "confirm",
      kind: "write",
      captcha: "none",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["token"],
        properties: { token: { type: "string", minLength: 16, maxLength: 128 } },
      },
      reads: ["subscribers"],
      writes: ["subscribers"],
      run: { action: "block", block: "double-opt-in.confirm", options: { table: "subscribers" } },
    },
  ],
  operations: ["noop"],
};
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,operations:{noop:async()=>null}};`;

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
/** No shipped plugins: the installed one is the only plugin either host runs. */
let pluginsRoot = "";
const stagingAdapter = stagingPublicAdapter(STAGING_ADMIN_URL);
const registry = new OperationRegistry();

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(url);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

async function call(name: string, input: unknown, ctx: Parameters<typeof execute>[2] = system) {
  const r = await execute(registry, adminAdapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  resetDispatchOnlyHost();
  for (const url of [ADMIN_URL, PUBLIC_ADMIN_URL] as string[]) {
    await onDb(url, (tx) => tx.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
  }
  await onDb(PUBLIC_ADMIN_URL as string, (tx) => tx`DELETE FROM mail_outbox`);
  await onDb(
    ADMIN_URL as string,
    (tx) => tx`UPDATE email_config SET transport = 'none', config_json = '{}' WHERE id = 1`,
  );
}

beforeAll(async () => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "2";
  await cleanup();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-t1729-gw-"));
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  registerAdminOps(registry);
  // `requires: ["email"]`: approval needs a transport that can deliver.
  await onDb(
    ADMIN_URL as string,
    (tx) => tx`UPDATE email_config SET transport = 'resend', from_address = 'noreply@t1729.test',
               config_json = '{"apiKey":"re_test_key"}' WHERE id = 1`,
  );
  const boot = await bootstrap({
    infra: { adapter: adminAdapter, registry },
    pluginsRoot,
    systemActorId: SYSTEM_ACTOR_ID,
  });
  expect(boot.failed).toEqual([]);
  // --- Admin side: stage, approve as an Owner, activate. ---
  const ownerId = crypto.randomUUID();
  await onDb(ADMIN_URL as string, async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${ownerId}::uuid, 'human', 'owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${ownerId}::uuid, ${`${ownerId}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${ownerId}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  const staged = (await call("plugins.stage_installation", { manifest, source })) as {
    installationId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item?.currentStateDigest,
      capabilities: ["email", "cms_admin"],
    },
    { ...system, actorId: ownerId, actorKind: "human" },
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  expect(loaded).toEqual({ loaded: true });
  await registerTestLiveOrigin(ADMIN_URL as string);
  await releaseProjectionForTests(adminAdapter, stagingAdapter, new Map([[SLUG, {}]]));
  // The admin process goes away; only the gateway's view remains.
  resetPluginHost();
  // --- Gateway side: its real identity, dispatch-only host. ---
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
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  invalidateRateLimitSpecCache();
  const report = await bootstrapDispatchOnly({
    infra: {
      adapter: gatewayAdapter,
      registry: new OperationRegistry(),
      mailLinks: gatewayMailLinks,
    },
    pluginsRoot,
    systemActorId: SYSTEM_ACTOR_ID,
  });
  expect(report.failed).toEqual([]);
  expect(report.loaded.map((p) => p.slug)).toContain(SLUG);
});

afterAll(async () => {
  await cleanup();
  await gatewayAdapter.close();
  await adminAdapter.close();
  await rm(pluginsRoot, { recursive: true, force: true });
});

describe("#1729 — a visitor's double opt-in of a runtime-installed plugin", () => {
  it("queues the plugin's confirmation template into the live outbox", async () => {
    expect(loadedPlugins.bySlug(SLUG)?.provenance).toBe("runtime-authored");
    const r = await handleRequest(
      new Request(`http://localhost/api/plugin/${SLUG}/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_LIVE_ORIGIN,
          "X-Forwarded-For": "203.0.113.17, 34.120.0.1",
        },
        body: JSON.stringify({ email: "Fan@Example.test" }),
      }),
    );
    expect({ status: r.status, body: await r.json() }).toEqual({
      status: 200,
      body: { ok: true, data: { awaitingConfirm: true } },
    });
    const rows = await onDb(
      PUBLIC_ADMIN_URL as string,
      (tx) =>
        tx`SELECT plugin_id::text AS plugin_id, template, recipient, token IS NOT NULL AS has_token
           FROM mail_outbox`,
    );
    expect(rows).toEqual([
      {
        plugin_id: loadedPlugins.bySlug(SLUG)?.pluginId,
        template: "confirm_it",
        recipient: "fan@example.test",
        has_token: true,
      },
    ]);
  });
});
