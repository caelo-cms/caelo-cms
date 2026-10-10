// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #613 — the API gateway runs without any admin_role credential.
 *
 * The admin side registers + provisions a fixture plugin as admin_role
 * (exactly as the admin host does); the gateway side then serves /api/*
 * through `handleRequest` with the gateway's real identities — gateway_role
 * on cms_admin, public_role on cms_public — and a dispatch-only plugin host.
 * Proves that forms-style plugin writes, private-storage reads, rate
 * limiting, captcha, honeypot, the request log and the plugin op audit all
 * work under the narrow grants (migration 0248), that the gateway follows
 * Owner activation/disable without a restart, and — adversarially — that
 * gateway_role reaches nothing else in cms_admin.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  bootstrapDispatchOnly,
  loadedPlugins,
  resetDispatchOnlyHost,
  resetPluginHost,
  syncDispatchPlugins,
} from "@caelo-cms/plugin-host";
import { adminSchemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { definePlugin, type PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { invalidateRateLimitSpecCache } from "./middleware/rate-limit.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  parseCookies,
  setGatewayAdapter,
} from "./server.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const GATEWAY_URL = process.env.GATEWAY_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !GATEWAY_URL || !PUBLIC_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL, PUBLIC_ADMIN_DATABASE_URL, GATEWAY_DATABASE_URL and PUBLIC_DATABASE_URL are required (bootstrap.sh creates gateway_role)",
  );
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t613-gw";
const SCHEMA = "plugin_t613_gw";

type AdminCtx = { adminQuery?: PluginAdminQuery };

const fixture = definePlugin({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: { notes: { id: "uuid", visitor_id: "string", message: "string" } },
  // `internal_note` and `drafts` are what a later version drops (#613 review).
  adminSchema: {
    settings: { label: "string", internal_note: "string" },
    drafts: { body: "string" },
  },
  requestedCapabilities: ["cms_admin_schema"],
  publicOperations: ["save", "read_setting"],
  operations: {
    save: async (ctx, args) => {
      const r = await ctx.query.insert("notes", {
        visitor_id: ctx.visitor.id,
        message: (args as { message: string }).message,
      });
      return { id: r.id };
    },
    // Visitor-facing read of the plugin's private cms_admin storage — the
    // consent-manager `record_consent` shape.
    read_setting: async (ctx) => {
      const q = (ctx as AdminCtx).adminQuery;
      if (!q) throw new Error("ctx.adminQuery missing");
      const rows = await q.list<"settings", { label: string }>("settings", { limit: 1 });
      return { label: rows[0]?.label ?? null };
    },
    admin_only: async () => ({ secret: true }),
  },
});

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let pluginId = "";

async function asAdmin<T>(fn: (tx: SQL) => Promise<T>, pluginScope?: string): Promise<T> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      if (pluginScope) await tx`SELECT set_config('caelo.plugin_id', ${pluginScope}, true)`;
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
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    await tx`DELETE FROM plugin_rate_limit_overrides WHERE plugin_slug = ${SLUG}`;
    await tx`DELETE FROM gateway_request_log WHERE plugin_slug = ${SLUG}`;
    await tx`DELETE FROM rate_limit_buckets WHERE key LIKE ${`%${SLUG}%`}`;
  });
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    await pub.end();
  }
}

let clientIp = 0;

/**
 * A visitor POST. Each request comes from its own client IP unless a
 * header says otherwise: cookie-less requests share an IP-scoped rate-limit
 * bucket, and one test's traffic must not throttle the next.
 */
function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  clientIp++;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": `198.51.100.${clientIp % 250}, 10.0.0.${Math.floor(clientIp / 250)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Assert a status, showing the response body when it differs. */
async function expectStatus(r: Response, status: number): Promise<void> {
  if (r.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${r.status}: ${await r.clone().text()}`);
  }
}

beforeAll(async () => {
  await cleanup();
  // --- Admin side: register + provision, as the admin host does. ---
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const adminReport = await bootstrap({
    infra: { adapter: adminAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: fixture }],
  });
  expect(adminReport.failed).toEqual([]);
  pluginId = await asAdmin(
    async (tx) =>
      ((await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as { id: string }[])[0]
        ?.id ?? "",
  );
  await asAdmin(async (tx) => {
    await tx.unsafe(`INSERT INTO ${SCHEMA}.settings (label) VALUES ('from-the-admin')`);
  }, pluginId);
  // The admin process goes away; only the gateway's view remains.
  resetPluginHost();

  // --- Gateway side: its real identities, dispatch-only host. ---
  const urls = gatewayDatabaseUrls({
    GATEWAY_DATABASE_URL: GATEWAY_URL,
    PUBLIC_DATABASE_URL: PUBLIC_URL,
  });
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: urls.gateway,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  invalidateRateLimitSpecCache();
  const report = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: fixture }],
  });
  expect(report.failed).toEqual([]);
  expect(report.loaded.map((p) => p.slug)).toEqual([SLUG]);
});

afterAll(async () => {
  await cleanup();
  await gatewayAdapter.close();
  await adminAdapter.close();
});

describe("gatewayDatabaseUrls (#613)", () => {
  it("refuses to start with any admin_role credential in the env", () => {
    for (const name of [
      "ADMIN_DATABASE_URL",
      "ADMIN_DATABASE_PASSWORD",
      "PUBLIC_ADMIN_DATABASE_URL",
      "PUBLIC_ADMIN_DATABASE_PASSWORD",
    ]) {
      expect(() =>
        gatewayDatabaseUrls({
          GATEWAY_DATABASE_URL: "postgres://gateway_role@h/cms_admin",
          PUBLIC_DATABASE_URL: "postgres://public_role@h/cms_public",
          [name]: "x",
        }),
      ).toThrow(new RegExp(`must not hold admin_role credentials.*${name}`));
    }
  });

  it("names a missing URL and composes passwords from their _PASSWORD companions", () => {
    expect(() => gatewayDatabaseUrls({ PUBLIC_DATABASE_URL: "postgres://p@h/cms_public" })).toThrow(
      /GATEWAY_DATABASE_URL/,
    );
    const urls = gatewayDatabaseUrls({
      GATEWAY_DATABASE_URL: "postgresql://gateway_role@h:5432/cms_admin",
      GATEWAY_DATABASE_PASSWORD: "g",
      PUBLIC_DATABASE_URL: "postgresql://public_role@h:5432/cms_public",
      PUBLIC_DATABASE_PASSWORD: "p",
    });
    expect(new URL(urls.gateway).password).toBe("g");
    expect(new URL(urls.public).password).toBe("p");
  });

  it("the gateway pool really is gateway_role, and the role is not privileged", async () => {
    const raw = gatewayAdapter.rawAdmin();
    const [who] = (await raw`SELECT current_user::text AS u`) as { u: string }[];
    expect(who?.u).toBe("gateway_role");
    const [attrs] = (await raw`
      SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit
      FROM pg_roles WHERE rolname = 'gateway_role'`) as Record<string, boolean>[];
    expect(attrs).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolinherit: false,
    });
    const memberships = (await raw`
      SELECT r.rolname::text AS role FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
      WHERE u.rolname = 'gateway_role'`) as { role: string }[];
    expect(memberships).toEqual([]);
  });
});

describe("/api/* served as gateway_role + public_role (#613)", () => {
  it("dispatches a visitor write, logs the request and audits the plugin op", async () => {
    const r = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "hi" }));
    await expectStatus(r, 200);
    expect(r.headers.get("set-cookie")).toContain("caelo_visitor_id=");
    const body = (await r.json()) as { ok: boolean; data: { id: string } };
    expect(body.ok).toBe(true);
    // The request log write is fire-and-forget; give it a moment.
    await Bun.sleep(200);
    const logged = await asAdmin(
      async (tx) =>
        (await tx`SELECT status_code FROM gateway_request_log WHERE plugin_slug = ${SLUG} AND operation = 'save'`) as {
          status_code: number;
        }[],
    );
    expect(logged.map((l) => l.status_code)).toContain(200);
    const audited = await asAdmin(
      async (tx) =>
        (await tx`SELECT a.operation FROM audit_events a JOIN actors ac ON ac.id = a.actor_id
                  WHERE ac.plugin_id = ${pluginId}::uuid`) as { operation: string }[],
    );
    expect(audited.map((a) => a.operation)).toContain(`${SLUG}.save`);
  });

  it("a visitor operation reads the plugin's private cms_admin storage", async () => {
    const r = await handleRequest(post(`/api/plugin/${SLUG}/read_setting`, {}));
    await expectStatus(r, 200);
    expect(((await r.json()) as { data: { label: string } }).data.label).toBe("from-the-admin");
  });

  it("still 404s an operation the plugin did not expose", async () => {
    const r = await handleRequest(post(`/api/plugin/${SLUG}/admin_only`, {}));
    expect(r.status).toBe(404);
  });

  it("honeypot: lies to the bot, consumes only an IP-scoped bucket", async () => {
    const r = await handleRequest(
      post(`/api/plugin/${SLUG}/save`, { message: "x", hp_address: "bot" }),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { accepted: boolean } }).data.accepted).toBe(true);
  });

  it("rate limits from an Owner override", async () => {
    await asAdmin(async (tx) => {
      await tx`INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds)
               VALUES (${SLUG}, 'save', 2, 60)`;
    });
    invalidateRateLimitSpecCache();
    const first = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "1" }));
    const cookie = parseCookies(first.headers.get("set-cookie")?.split(";")[0] ?? null);
    await expectStatus(first, 200);
    // A signed visitor cookie moves the visitor onto its own bucket.
    const header = { cookie: `caelo_visitor_id=${cookie.caelo_visitor_id ?? ""}` };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "n" }, header));
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    await asAdmin(async (tx) => {
      await tx`DELETE FROM plugin_rate_limit_overrides WHERE plugin_slug = ${SLUG}`;
    });
    invalidateRateLimitSpecCache();
  });

  it("captcha: issues a challenge, accepts its proof once, rejects the replay", async () => {
    const saved = await asAdmin(async (tx) => {
      const [row] =
        (await tx`SELECT captcha_provider, captcha_pow_target_prefix FROM site_settings WHERE id = 1`) as {
          captcha_provider: string;
          captcha_pow_target_prefix: string;
        }[];
      // One hex digit keeps the proof cheap to compute in a test.
      await tx`UPDATE site_settings SET captcha_provider = 'pow', captcha_pow_target_prefix = '0' WHERE id = 1`;
      return row;
    });
    invalidateGatewaySettings();
    try {
      const c = await handleRequest(new Request("http://localhost/api/captcha/challenge"));
      expect(c.status).toBe(200);
      const { challenge, target } = (
        (await c.json()) as { data: { challenge: string; target: string } }
      ).data;
      let nonce = 0;
      for (;;) {
        const hex = new Bun.CryptoHasher("sha256").update(`${challenge}${nonce}`).digest("hex");
        if (hex.startsWith(target)) break;
        nonce++;
      }
      const proof = { _caelo_captcha: { challenge, nonce: String(nonce) } };
      const ok = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "c", ...proof }));
      await expectStatus(ok, 200);
      const replay = await handleRequest(
        post(`/api/plugin/${SLUG}/save`, { message: "c", ...proof }),
      );
      await expectStatus(replay, 403);
    } finally {
      await asAdmin(async (tx) => {
        await tx`UPDATE site_settings SET captcha_provider = ${saved?.captcha_provider ?? "pow"},
                 captcha_pow_target_prefix = ${saved?.captcha_pow_target_prefix ?? "000fff"} WHERE id = 1`;
      });
      invalidateGatewaySettings();
    }
  });

  it("follows the admin's registry: a disable detaches, a re-activation re-attaches", async () => {
    await asAdmin(async (tx) => {
      await tx`UPDATE plugins SET status = 'disabled' WHERE slug = ${SLUG}`;
    });
    await syncDispatchPlugins({ force: true });
    expect(loadedPlugins.bySlug(SLUG)).toBeUndefined();
    const off = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "x" }));
    await expectStatus(off, 404);

    await asAdmin(async (tx) => {
      await tx`UPDATE plugins SET status = 'active' WHERE slug = ${SLUG}`;
    });
    await syncDispatchPlugins({ force: true });
    const on = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "x" }));
    await expectStatus(on, 200);
  });
});

describe("gateway_role reaches nothing else in cms_admin (#613, adversarial)", () => {
  /** Run `query` as gateway_role in a system-scoped tx; resolve to the error message or "ok". */
  async function attempt(query: ReturnType<typeof sql>): Promise<string> {
    try {
      await gatewayAdapter.withAdminTransaction(
        { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t613" },
        async (tx) => tx.execute(query),
      );
      return "ok";
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
    }
  }

  it("cannot read users, AI provider keys, pages or the full settings row", async () => {
    expect(await attempt(sql`SELECT * FROM users LIMIT 1`)).toMatch(/permission denied/);
    expect(await attempt(sql`SELECT * FROM ai_providers LIMIT 1`)).toMatch(/permission denied/);
    expect(await attempt(sql`SELECT * FROM pages LIMIT 1`)).toMatch(/permission denied/);
    expect(await attempt(sql`SELECT * FROM site_settings`)).toMatch(/permission denied/);
    expect(await attempt(sql`SELECT manifest_signature FROM plugins`)).toMatch(/permission denied/);
    expect(await attempt(sql`SELECT gateway_cookie_secret FROM site_settings`)).toBe("ok");
  });

  it("cannot write authoring data or its own settings", async () => {
    expect(await attempt(sql`UPDATE site_settings SET gateway_max_body_bytes = 1`)).toMatch(
      /permission denied/,
    );
    expect(await attempt(sql`UPDATE plugins SET status = 'active'`)).toMatch(/permission denied/);
    expect(await attempt(sql`DELETE FROM gateway_request_log`)).toMatch(/permission denied/);
    expect(
      await attempt(sql`INSERT INTO actors (kind, display_name) VALUES ('system', 'x')`),
    ).toMatch(/permission denied/);
  });

  it("touches only the gateway's own rate-limit buckets", async () => {
    expect(
      await attempt(sql`INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
                        VALUES ('login:someone', now(), 1, now())`),
    ).toMatch(/row-level security/);
    expect(
      await attempt(sql`INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
                        VALUES (${`gateway:${SLUG}:probe`}, now(), 1, now())`),
    ).toBe("ok");
  });

  it("audits only as a plugin actor", async () => {
    expect(
      await attempt(sql`INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
                        VALUES (${SYSTEM_ACTOR_ID}::uuid, 'pages.delete', 'x', true)`),
    ).toMatch(/row-level security/);
  });

  it("has no privilege on cms_public — it is a cms_admin-only login", async () => {
    const rows = await asAdmin(
      async (tx) =>
        (await tx`SELECT has_database_privilege('gateway_role', 'cms_public', 'CONNECT') AS c`) as {
          c: boolean;
        }[],
    );
    expect(rows[0]?.c).toBe(false);
  });
});

describe("a plugin update that drops private columns/tables (#613 review)", () => {
  /** Whether gateway_role may SELECT a column of the plugin's private schema. */
  async function canRead(table: string, column: string): Promise<boolean> {
    const rows = await asAdmin(
      async (tx) =>
        (await tx`SELECT has_column_privilege('gateway_role', ${`${SCHEMA}.${table}`}, ${column}, 'SELECT') AS c`) as {
          c: boolean;
        }[],
    );
    return rows[0]?.c ?? false;
  }

  it("re-provisioning revokes what the new spec no longer declares, keeps what it does", async () => {
    expect(await canRead("settings", "internal_note")).toBe(true);
    expect(await canRead("drafts", "body")).toBe(true);
    // The new version: `internal_note` and `drafts` are gone from the spec
    // but stay physically (schema evolution is additive).
    const next = adminSchemaFromSpec({
      pluginId,
      slug: SLUG,
      adminSchema: { settings: { label: "string" } },
      visitorReadable: true,
    });
    await adminAdapter.provisionPluginAdminSchema({ pluginId, sql: next.sql });
    expect(await canRead("settings", "label")).toBe(true);
    expect(await canRead("settings", "internal_note")).toBe(false);
    expect(await canRead("drafts", "body")).toBe(false);
  });
});
