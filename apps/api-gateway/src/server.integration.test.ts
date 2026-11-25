// SPDX-License-Identifier: MPL-2.0

/**
 * P12 PR1.4 — API gateway request handler integration tests.
 *
 * Bootstraps the plugin host with a Tier-1 fixture plugin + provisions
 * its cms_public schema, then drives the gateway's `handleRequest` with
 * synthetic Request objects (no live socket needed). Asserts:
 *   - POST /api/plugin/<slug>/<op> dispatches via runPluginOperation.
 *   - With no consent provider running nobody can have consented to the
 *     visitor id (#677): none is set, a held one is removed, and the
 *     plugin sees `ctx.visitor.id === null`. The consented paths are in
 *     visitor-consent.integration.test.ts.
 *   - A visitor login lives in the `__session` cookie and survives a
 *     proxy that forwards nothing else (Firebase Hosting, #1343).
 *   - 404 / 400 / 503 status codes for missing plugin / bad route / disabled.
 *   - JSON body parsing errors return 400.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { publishProjectionOnce, stagingPublicAdapter } from "@caelo-cms/admin-core";
import { applyPluginLifecycle, bootstrap, resetPluginHost } from "@caelo-cms/plugin-host";
import { publicGrantTargets, schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { definePlugin, visitorAuthInputs, z } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { DEFAULT_INSTALL_NAMES, sessionCookieValue } from "@caelo-cms/shared";
import { SQL } from "bun";
import { handleRequest, invalidateGatewaySettings, setGatewayAdapter } from "./server.js";
import { registerTestLiveOrigin, TEST_LIVE_ORIGIN } from "./test-support.js";

const LIVE_TARGET = publicGrantTargets(DEFAULT_INSTALL_NAMES.roles).live;

/** #1329 — the admin's adapter on the staging twin of cms_public. */
const STAGING_ADAPTER = stagingPublicAdapter(process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL ?? "");

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_ROLE_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !PUBLIC_ROLE_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-p12-gw";
const VISITOR_EMAIL = "v@example.com";
const VISITOR_PASSWORD = "correct horse battery";

let adapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
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
    // #1340 — the visitor login is core's block on the auth tables.
    public_users: {
      id: "uuid",
      email: "string",
      email_key: "string",
      password_hash: "string",
      email_verified_at: "timestamp_nullable",
      created_at: "timestamp",
      last_login_at: "timestamp_nullable",
    },
    visitor_sessions: {
      id: "uuid",
      public_user_id: "string",
      token_hash: "string",
      expires_at: "timestamp",
      created_at: "timestamp",
    },
    login_throttle: {
      id: "uuid",
      email_hash: "string",
      failures: "int",
      window_started_at: "timestamp",
      created_at: "timestamp",
    },
  },
  tableKinds: {
    notes: "visitor-state",
    public_users: "visitor-state",
    visitor_sessions: "visitor-state",
    login_throttle: "visitor-state",
  },
  // The reads the login block makes (its contract names them, #1292).
  indexes: {
    schema: {
      public_users: [["email"]],
      visitor_sessions: [["token_hash"], ["public_user_id"]],
      login_throttle: [{ columns: ["email_hash"], unique: true }],
    },
  },
  requestedCapabilities: ["email"],
  // Default deny at the visitor boundary: the fixture has to say which
  // operations the gateway may reach. #1340 — each is a declaration.
  publicOperations: [
    {
      name: "save",
      kind: "write" as const,
      captcha: "none" as const,
      input: z.looseObject({}),
      reads: ["notes"],
      writes: ["notes"],
      run: {
        action: "insert" as const,
        table: "notes",
        values: {
          visitor_id: { from: "visitor" as const, key: "id" as const },
          message: { from: "input" as const, field: "message" },
        },
        answer: { id: { from: "inserted-id" as const } },
      },
    },
    {
      name: "login",
      kind: "write" as const,
      captcha: "none" as const,
      input: visitorAuthInputs.credentials,
      reads: ["login_throttle", "public_users"],
      writes: ["login_throttle", "public_users", "visitor_sessions"],
      run: { action: "block" as const, block: "visitor-auth.login" as const },
    },
    {
      name: "me",
      kind: "read" as const,
      captcha: "none" as const,
      input: visitorAuthInputs.session,
      reads: ["visitor_sessions", "public_users"],
      run: { action: "block" as const, block: "visitor-auth.me" as const },
    },
    {
      name: "logout",
      kind: "write" as const,
      captcha: "none" as const,
      input: visitorAuthInputs.session,
      reads: ["visitor_sessions"],
      writes: ["visitor_sessions"],
      run: { action: "block" as const, block: "visitor-auth.logout" as const },
    },
  ],
  operations: {
    admin_only: async () => ({ secret: "should never be reachable from the gateway" }),
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
    target: LIVE_TARGET,
    tableKinds: fixturePlugin.tableKinds,
    pluginId: id,
    slug: SLUG,
    schema: fixturePlugin.schema,
    indexes: fixturePlugin.indexes?.schema,
  });
  await adapter.provisionPluginPublicSchema({ pluginId: id, sql: emitted.sql });
}

/** The fixture plugin's id (its tables' RLS scope). */
async function fixturePluginId(): Promise<string> {
  const admin = new SQL(ADMIN_URL as string);
  try {
    const rows = (await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`;
    })) as unknown as { id: string }[];
    if (!rows[0]) throw new Error("plugin row missing");
    return rows[0].id;
  } finally {
    await admin.end();
  }
}

/** The visitor id the gateway stored with a `save` (null without consent, #677). */
async function storedVisitorId(id: string): Promise<string | null> {
  const pub = new SQL(PUBLIC_URL as string);
  try {
    const rows = (await pub.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`SELECT set_config('caelo.plugin_id', ${await fixturePluginId()}, true)`;
      return tx.unsafe(`SELECT visitor_id FROM plugin_test_p12_gw.notes WHERE id = $1`, [id]);
    })) as unknown as { visitor_id: string | null }[];
    if (!rows[0]) throw new Error(`no stored note ${id}`);
    return (rows[0] as { visitor_id: string | null }).visitor_id;
  } finally {
    await pub.end();
  }
}

/** A visitor account whose address was verified (the login block refuses others). */
async function seedVerifiedVisitor(): Promise<void> {
  const hash = await Bun.password.hash(VISITOR_PASSWORD, {
    algorithm: "argon2id",
    memoryCost: 19_456,
    timeCost: 2,
  });
  const pub = new SQL(PUBLIC_URL as string);
  try {
    await pub.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`SELECT set_config('caelo.plugin_id', ${await fixturePluginId()}, true)`;
      await tx.unsafe(
        `INSERT INTO plugin_test_p12_gw.public_users (email, email_key, password_hash, email_verified_at) VALUES ($1, $2, $3, now())`,
        [VISITOR_EMAIL, "k-v", hash],
      );
    });
  } finally {
    await pub.end();
  }
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
  process.env.CAELO_TRUSTED_PROXY_HOPS = "1";
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  // P13 — gateway needs an adapter handle for body cap, signed cookies,
  // rate limit, captcha, request log. #635: its own identity, public_role
  // on cms_public only, reading what the admin published.
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: PUBLIC_ROLE_URL,
    expectedRoles: { admin: null, public: ["public_role"] },
  });
  setGatewayAdapter(gatewayAdapter);
  await registerTestLiveOrigin(ADMIN_URL);
  await publishProjectionOnce(adapter, STAGING_ADAPTER, { declarations: new Map() });
  invalidateGatewaySettings();
});

afterEach(async () => {
  await wipe();
  invalidateGatewaySettings();
});

afterAll(async () => {
  await adapter.close();
  await gatewayAdapter.close();
});

// Behind one proxy (self-hosted Caddy sets X-Forwarded-For to its peer).
function postReq(path: string, body: unknown, cookieHeader?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Forwarded-For": "203.0.113.20",
    Origin: TEST_LIVE_ORIGIN,
  };
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

  it("dispatches a plugin op without a visitor id when no consent provider runs (#677)", async () => {
    await bootstrapAndProvision();
    const r = await handleRequest(postReq(`/api/plugin/${SLUG}/save`, { message: "hi" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    const body = (await r.json()) as { ok: boolean; data: { id: string } };
    expect(body.ok).toBe(true);
    expect(await storedVisitorId(body.data.id)).toBeNull();
  });

  it("404s an operation the plugin did not expose to visitors", async () => {
    // Every declared operation used to be reachable here with the
    // plugin's full capabilities — that put `comments/moderate`,
    // `forms/list_submissions`, `newsletter/send_campaign` and
    // `international-site/set_locales` on the open internet behind
    // nothing but a rate limit. Dispatch is default-deny now, and the
    // gateway answers 404 rather than 403 so a prober cannot use the
    // status to confirm that the operation exists.
    await bootstrapAndProvision();
    const r = await handleRequest(postReq(`/api/plugin/${SLUG}/admin_only`, {}));
    expect(r.status).toBe(404);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("removes a visitor id the browser still holds and ignores it (#677)", async () => {
    await bootstrapAndProvision();
    // Shaped like a signed id; whether its signature is valid does not
    // matter — without consent the gateway never reads the id.
    const held = `11111111-1111-4111-8111-111111111111.${Math.floor(Date.now() / 1000)}.${"0".repeat(64)}`;
    const container = sessionCookieValue(
      new Map([["vid", { value: held, expiresAt: Math.floor(Date.now() / 1000) + 60 }]]),
    );
    const r = await handleRequest(
      postReq(`/api/plugin/${SLUG}/save`, { message: "x" }, `__session=${container}`),
    );
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toStartWith("__session=;");
    expect(setCookie).toContain("Max-Age=0");
    const body = (await r.json()) as { data: { id: string } };
    expect(await storedVisitorId(body.data.id)).toBeNull();
  });

  it("keeps a visitor logged in behind a proxy that forwards only __session (#1343)", async () => {
    await bootstrapAndProvision();
    // Firebase Hosting strips every cookie but __session on its way to the
    // gateway; the browser still holds the others.
    const jar = new Map<string, string>([
      ["caelo_consent", "x"],
      ["other", "1"],
    ]);
    const call = async (op: string, body: unknown = {}) => {
      const forwarded = jar.has("__session") ? `__session=${jar.get("__session")}` : undefined;
      const r = await handleRequest(postReq(`/api/plugin/${SLUG}/${op}`, body, forwarded));
      for (const c of r.headers.getSetCookie()) {
        const [pair = "", ...flags] = c.split("; ");
        const eq = pair.indexOf("=");
        if (flags.includes("Max-Age=0")) jar.delete(pair.slice(0, eq));
        else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return (await r.json()) as { data: { authenticated?: boolean } };
    };
    await seedVerifiedVisitor();
    expect((await call("me")).data.authenticated).toBe(false);
    await call("login", { email: VISITOR_EMAIL, password: VISITOR_PASSWORD });
    expect(jar.has("__session")).toBe(true);
    expect((await call("me")).data.authenticated).toBe(true);
    expect((await call("me")).data.authenticated).toBe(true);
    await call("logout");
    expect(jar.has("__session")).toBe(false);
    expect((await call("me")).data.authenticated).toBe(false);
  });

  it("does not fail on a malformed cookie header", async () => {
    await bootstrapAndProvision();
    const r = await handleRequest(
      postReq(`/api/plugin/${SLUG}/save`, { message: "x" }, "caelo_consent=%E0%A4%A; other=1"),
    );
    expect(r.status).toBe(200);
  });

  it("returns 404 for an unknown plugin slug", async () => {
    await bootstrapAndProvision();
    const r = await handleRequest(postReq(`/api/plugin/test-p12-nope/save`, {}));
    expect(r.status).toBe(404);
    const body = (await r.json()) as { ok: boolean; error: { kind: string } };
    expect(body.error.kind).toBe("NotFound");
  });

  it("writes no database row for an unknown plugin or operation (#1326)", async () => {
    await bootstrapAndProvision();
    const counts = async () => {
      const sql = new SQL(PUBLIC_URL);
      try {
        return await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const [row] = (await tx`SELECT
              (SELECT count(*)::int FROM gateway_request_log) AS log,
              (SELECT count(*)::int FROM gateway_rate_limit_buckets) AS buckets,
              (SELECT count(*)::int FROM gateway_plugin_op_events) AS events`) as {
            log: number;
            buckets: number;
            events: number;
          }[];
          return row;
        });
      } finally {
        await sql.end();
      }
    };
    const before = await counts();
    for (const path of [
      "/api/plugin/test-p12-nope/save",
      `/api/plugin/${SLUG}/invented_${Date.now()}`,
      `/api/plugin/${SLUG}/admin_only`,
      `/api/plugin/${"x".repeat(80)}/save`,
    ]) {
      const r = await handleRequest(postReq(path, { message: "x" }));
      expect(r.status).toBe(404);
    }
    expect(await counts()).toEqual(before);
  });

  it("answers every error as { kind, requestId } and logs the details under that id (#1326)", async () => {
    await bootstrapAndProvision();
    const r = await handleRequest(postReq(`/api/plugin/${SLUG}/save`, "not an object"));
    const body = (await r.json()) as { ok: boolean; error: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(Object.keys(body.error).sort()).toEqual(["kind", "requestId"]);
    expect(r.headers.get("x-request-id")).toBe(String(body.error.requestId));
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses a staged page's plugin call on the live gateway: staging posts to its own gateway (#1330)", async () => {
    await bootstrapAndProvision();
    const asSystem = async (fn: (tx: SQL) => Promise<unknown>) => {
      const sql = new SQL(ADMIN_URL);
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          await fn(tx);
        });
      } finally {
        await sql.end();
      }
    };
    await asSystem(
      (tx) => tx`UPDATE staging_access SET staging_host = 'staging.localhost' WHERE id = 1`,
    );
    await publishProjectionOnce(adapter, STAGING_ADAPTER, { declarations: new Map() });
    invalidateGatewaySettings();
    try {
      const req = postReq(`/api/plugin/${SLUG}/save`, { message: "from staging" });
      req.headers.set("Origin", "https://staging.localhost");
      const r = await handleRequest(req);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { kind: string } }).error.kind).toBe("OriginNotAllowed");
      // Staging is never a live origin, whatever the domains registry says.
      const live = await new SQL(PUBLIC_URL).begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return (await tx`SELECT live_origins FROM published_gateway_settings`) as {
          live_origins: string[];
        }[];
      });
      expect(live[0]?.live_origins).not.toContain("https://staging.localhost");
    } finally {
      await asSystem((tx) => tx`UPDATE staging_access SET staging_host = NULL WHERE id = 1`);
      await publishProjectionOnce(adapter, STAGING_ADAPTER, { declarations: new Map() });
      invalidateGatewaySettings();
    }
  });

  it("refuses a foreign or a missing Origin, and non-JSON, before dispatch (#1326)", async () => {
    await bootstrapAndProvision();
    for (const [headers, status] of [
      [{ Origin: "https://evil.example" }, 403],
      [{ Origin: "" }, 403],
      [{ "Content-Type": "text/plain" }, 415],
    ] as const) {
      const req = postReq(`/api/plugin/${SLUG}/save`, { message: "x" });
      for (const [k, v] of Object.entries(headers)) {
        if (v === "") req.headers.delete(k);
        else req.headers.set(k, v);
      }
      expect((await handleRequest(req)).status).toBe(status);
    }
  });

  it("returns 503 when the plugin is disabled", async () => {
    await bootstrapAndProvision();
    applyPluginLifecycle(SLUG, "disable");
    const r = await handleRequest(postReq(`/api/plugin/${SLUG}/save`, { message: "x" }));
    expect(r.status).toBe(503);
  });

  it("returns 400 for malformed JSON", async () => {
    await bootstrapAndProvision();
    const r = await handleRequest(
      new Request(`http://localhost/api/plugin/${SLUG}/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.20",
          Origin: TEST_LIVE_ORIGIN,
        },
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
