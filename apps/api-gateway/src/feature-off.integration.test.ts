// SPDX-License-Identifier: MPL-2.0

/**
 * #1339 / #762 (epic #763 E14 a) — the live gateway while no active plugin
 * serves an operation to visitors: it is provisioned (zero minimum
 * instances) and answers the fixed 404 of an unknown path on every visitor
 * route, before it reads the request and, once it learned the state while
 * its published-state LISTEN holds, without touching the database. The
 * Owner activating a visitor-facing plugin turns it on with no redeploy: the
 * admin's publish notifies, and the next request reads the registry again.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  publishProjectionOnce,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "@caelo-cms/admin-core";
import {
  bootstrap,
  bootstrapDispatchOnly,
  resetPluginHost,
  servesVisitorOperations,
} from "@caelo-cms/plugin-host";
import { definePlugin, z } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, type ListenHandle, OperationRegistry } from "@caelo-cms/query-api";
import { GATEWAY_DATABASE_ROLES, gatewayDatabaseUrls } from "./database-env.js";
import { listenForPublishedChanges, onPublishedChange } from "./published-changes.js";
import { handleRequest, invalidateGatewaySettings, setGatewayAdapter } from "./server.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL || !STAGING_ADMIN_URL) {
  throw new Error("DB URLs required");
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-e14-off";

const fixture = definePlugin({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: { notes: { id: "uuid", message: "string" } },
  tableKinds: { notes: "visitor-state" },
  publicOperations: [
    {
      name: "save",
      kind: "write" as const,
      captcha: "none" as const,
      input: z.looseObject({}),
      reads: ["notes"],
      writes: ["notes"],
    },
  ],
  operations: { save: async () => ({ saved: true }) },
});

let adminAdapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let listening: ListenHandle;
let reads = 0;

/** The gateway's adapter, counting every cms_public transaction it opens. */
function counting(target: DatabaseAdapter): DatabaseAdapter {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "withPublicTransaction") reads++;
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

/** A visitor request that carries nothing: no client address, no Origin, no body. */
const bare = (method: string, path: string) => new Request(`http://localhost${path}`, { method });

beforeAll(async () => {
  // Behind a load balancer: a request without X-Forwarded-For would be a
  // 503 if the gateway read its client address.
  process.env.CAELO_TRUSTED_PROXY_HOPS = "2";
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  staging = stagingPublicAdapter(STAGING_ADMIN_URL);
  // The admin published a registry with no active plugin.
  await publishProjectionOnce(adminAdapter, staging, { declarations: new Map() });

  const urls = gatewayDatabaseUrls({
    PUBLIC_DATABASE_URL: PUBLIC_URL,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  });
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  setGatewayAdapter(counting(gatewayAdapter));
  // As the gateway boots (server.ts main): every notification drops the caches.
  onPublishedChange(invalidateGatewaySettings);
  listening = await listenForPublishedChanges(gatewayAdapter);
  const report = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    // Shipped in this image, but not active: the Owner has not turned it on.
    testPlugins: [{ definition: fixture }],
  });
  expect(report.loaded).toEqual([]);
});

afterAll(async () => {
  await listening.unlisten();
  resetPluginHost();
  await gatewayAdapter.close();
  await staging.close();
  await adminAdapter.close();
});

describe("E14 a: the live gateway with no visitor-facing plugin active", () => {
  it("answers the fixed 404 on every visitor route, then without the database", async () => {
    expect(servesVisitorOperations()).toBe(false);
    // The first request after a publish learns the state with one registry
    // read, before anything of the request is read: no client address
    // (which would be a 503 here) is needed for the fixed 404 (#1429 review).
    const first = await handleRequest(bare("GET", "/api/captcha/challenge"));
    expect(first.status).toBe(404);
    reads = 0;
    for (const [method, path] of [
      ["GET", "/api/captcha/challenge"],
      ["POST", `/api/plugin/${SLUG}/save`],
      ["POST", "/api/plugin/forms/submit"],
      ["GET", "/api/anything"],
    ] as const) {
      const r = await handleRequest(bare(method, path));
      expect(r.status).toBe(404);
      const body = (await r.json()) as { ok: boolean; error: Record<string, unknown> };
      expect(body.ok).toBe(false);
      // The same answer as for a path that names no route: nothing to tell apart.
      expect(Object.keys(body.error).sort()).toEqual(["kind", "requestId"]);
      expect(body.error.kind).toBe("NotFound");
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    expect(reads).toBe(0);
  });

  it("keeps the liveness probe and the upgrade's health check", async () => {
    expect((await handleRequest(bare("GET", "/healthz"))).status).toBe(200);
    expect((await handleRequest(bare("GET", "/api/_caelo/health"))).status).toBe(200);
  });

  it("turns on when the Owner activates a visitor-facing plugin, with no redeploy", async () => {
    const adminReport = await bootstrap({
      infra: { adapter: adminAdapter, registry: new OperationRegistry() },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: fixture }],
    });
    expect(adminReport.failed).toEqual([]);
    // The admin's publish notifies the gateway (#1267), which forgets "off".
    await releaseProjectionForTests(adminAdapter, staging, new Map([[SLUG, null]]));
    // The admin's host goes away (it shares this process); the gateway's
    // running host stays as it was booted.
    resetPluginHost();
    await waitFor(() => servesVisitorOperations() === null);
    const r = await handleRequest(
      new Request(`http://localhost/api/plugin/${SLUG}/save`, {
        method: "POST",
        headers: { "X-Forwarded-For": "198.51.100.7, 34.1.2.3" },
      }),
    );
    // Past the off switch: the request is read now and refused by the input
    // filter (no Origin), not by the fixed 404.
    expect(servesVisitorOperations()).toBe(true);
    expect(r.status).not.toBe(404);
    invalidateGatewaySettings();
  });
});

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}
