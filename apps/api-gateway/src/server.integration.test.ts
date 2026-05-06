// SPDX-License-Identifier: MPL-2.0

/**
 * P12 PR1.4 — API gateway request handler integration tests.
 *
 * Bootstraps the plugin host with a Tier-1 fixture plugin + provisions
 * its cms_public schema, then drives the gateway's `handleRequest` with
 * synthetic Request objects (no live socket needed). Asserts:
 *   - POST /api/plugin/<slug>/<op> dispatches via runPluginOperation.
 *   - Visitor cookie is set on first contact, reused on second.
 *   - Plugin's ctx.visitor.id matches the cookie value.
 *   - 404 / 400 / 503 status codes for missing plugin / bad route / disabled.
 *   - JSON body parsing errors return 400.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { applyPluginLifecycle, bootstrap, resetPluginHost } from "@caelo-cms/plugin-host";
import { schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  handleRequest,
  invalidateGatewaySettings,
  parseCookies,
  setGatewayAdapter,
} from "./server.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-p12-gw";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const fixturePlugin = definePlugin({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: {
    notes: {
      id: "uuid",
      visitor_id: "string",
      message: "string",
      created_at: "timestamp",
    },
  },
  operations: {
    save: async (ctx, args) => {
      const a = args as { message: string };
      const r = await ctx.query.insert("notes", {
        visitor_id: ctx.visitor.id,
        message: a.message,
      });
      return { id: r.id, visitorSeen: ctx.visitor.id };
    },
    bump: async (_ctx, _args) => ({ ok: true }),
  },
});

async function wipe(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // v0.2.16 — clear plugin-emitted audit rows before the actor.
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    });
  } finally {
    await sql.end();
  }
  const pub = new SQL(PUBLIC_URL);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_test_p12_gw CASCADE`);
  } finally {
    await pub.end();
  }
}

async function provisionSchema(): Promise<void> {
  const id = await adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "p" },
    async (tx) => {
      const { sql } = await import("drizzle-orm");
      const rows = (await tx.execute(
        sql`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`,
      )) as unknown as { id: string }[];
      return rows[0]?.id;
    },
  );
  if (!id) throw new Error("plugin row missing");
  const emitted = schemaFromSpec({
    pluginId: id,
    slug: SLUG,
    schema: {
      notes: { id: "uuid", visitor_id: "string", message: "string", created_at: "timestamp" },
    },
  });
  await adapter.provisionPluginPublicSchema({ pluginId: id, sql: emitted.sql });
}

async function bootstrapAndProvision(): Promise<void> {
  await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: fixturePlugin }],
  });
  await provisionSchema();
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  // P13 — gateway needs an adapter handle for body cap, signed cookies,
  // rate limit, captcha, request log.
  setGatewayAdapter(adapter);
  invalidateGatewaySettings();
});

afterEach(async () => {
  await wipe();
  invalidateGatewaySettings();
});

afterAll(async () => {
  await adapter.close();
});

function postReq(path: string, body: unknown, cookieHeader?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookieHeader) headers.cookie = cookieHeader;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("api-gateway handleRequest (P12 PR1.4)", () => {
  it("healthz returns ok", async () => {
    const r = await handleRequest(new Request("http://localhost/healthz"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("dispatches a plugin op + sets visitor cookie on first contact", async () => {
    await bootstrapAndProvision();
    const r = await handleRequest(postReq(`/api/plugin/${SLUG}/save`, { message: "hi" }));
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie");
    expect(setCookie).toContain("caelo_visitor_id=");
    expect(setCookie).toContain("HttpOnly");
    // P13 — cookie value is signed: `<uuid>.<issuedAt>.<sig>`. The raw
    // UUID is the first dot-separated segment.
    const cookies = parseCookies(setCookie?.split(";")[0] ?? null);
    const signed = cookies.caelo_visitor_id ?? "";
    const visitorId = signed.split(".")[0] ?? "";
    expect(visitorId).toMatch(/^[0-9a-f-]{36}$/);

    const body = (await r.json()) as { ok: boolean; data: { visitorSeen: string } };
    expect(body.ok).toBe(true);
    expect(body.data.visitorSeen).toBe(visitorId);
  });

  it("reuses existing signed visitor cookie on second contact", async () => {
    await bootstrapAndProvision();
    // Round-trip via a real first request to learn the signed cookie,
    // then reuse it as the second-contact cookie.
    const r1 = await handleRequest(postReq(`/api/plugin/${SLUG}/save`, { message: "first" }));
    const setCookie = r1.headers.get("set-cookie") ?? "";
    const signedVisitor = parseCookies(setCookie.split(";")[0] ?? null).caelo_visitor_id ?? "";
    expect(signedVisitor).not.toBe("");

    const r2 = await handleRequest(
      postReq(`/api/plugin/${SLUG}/save`, { message: "x" }, `caelo_visitor_id=${signedVisitor}`),
    );
    expect(r2.status).toBe(200);
    // Existing valid cookie → no Set-Cookie header (we only set on fresh visitors).
    expect(r2.headers.get("set-cookie")).toBeNull();
    const body = (await r2.json()) as { data: { visitorSeen: string } };
    const expectedVisitorId = signedVisitor.split(".")[0];
    expect(body.data.visitorSeen).toBe(expectedVisitorId);
  });

  it("rejects a tampered visitor cookie + issues fresh visitor", async () => {
    await bootstrapAndProvision();
    // Tampered cookie (right shape but wrong signature) → treat as fresh.
    const tampered = `00000000-0000-0000-0000-000000000000.${Math.floor(Date.now() / 1000)}.${"0".repeat(64)}`;
    const r = await handleRequest(
      postReq(`/api/plugin/${SLUG}/save`, { message: "x" }, `caelo_visitor_id=${tampered}`),
    );
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("caelo_visitor_id=");
    const fresh = parseCookies(setCookie.split(";")[0] ?? null).caelo_visitor_id ?? "";
    expect(fresh.split(".")[0]).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("returns 404 for an unknown plugin slug", async () => {
    await bootstrapAndProvision();
    const r = await handleRequest(postReq(`/api/plugin/test-p12-nope/save`, {}));
    expect(r.status).toBe(404);
    const body = (await r.json()) as { ok: boolean; error: { kind: string } };
    expect(body.error.kind).toBe("PluginNotFound");
  });

  it("returns 503 when the plugin is disabled", async () => {
    await bootstrapAndProvision();
    applyPluginLifecycle(SLUG, "disable");
    const r = await handleRequest(postReq(`/api/plugin/${SLUG}/save`, { message: "x" }));
    expect(r.status).toBe(503);
  });

  it("returns 400 for malformed JSON", async () => {
    const r = await handleRequest(
      new Request(`http://localhost/api/plugin/${SLUG}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(r.status).toBe(400);
  });

  it("returns 404 for non-plugin routes", async () => {
    const r = await handleRequest(postReq(`/api/something-else`, {}));
    expect(r.status).toBe(404);
  });
});
