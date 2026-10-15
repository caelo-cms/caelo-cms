// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — the API gateway runs with NO cms_admin login.
 *
 * The admin side registers + provisions a fixture plugin as admin_role
 * (exactly as the admin host does) and publishes the gateway projection
 * into cms_public; the gateway side then serves /api/* through
 * `handleRequest` with its real identity — public_role on cms_public, and
 * an adapter that has no cms_admin pool at all — and a dispatch-only plugin
 * host. Proves that plugin writes, the declared visitor projection of
 * private storage, rate limiting, captcha, honeypot, the request log, the
 * plugin op events and the staging gate all work from cms_public alone,
 * that the projection follows admin writes through the outbox, and —
 * adversarially — that the public side can neither reach cms_admin nor
 * rewrite what the admin published.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drainProjectionOnce, publishProjectionOnce } from "@caelo-cms/admin-core";
import {
  bootstrap,
  bootstrapDispatchOnly,
  loadedPlugins,
  resetDispatchOnlyHost,
  resetPluginHost,
  syncDispatchPlugins,
} from "@caelo-cms/plugin-host";
import { definePlugin, type PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import {
  AdminDatabaseUnavailableError,
  DatabaseAdapter,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { STAGING_SESSION_COOKIE, signStagingToken } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
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
const SLUG = "t635-gw";
const SCHEMA = "plugin_t635_gw";

type AdminCtx = { adminQuery?: PluginAdminQuery };

const fixture = definePlugin({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: { notes: { id: "uuid", visitor_id: "string", message: "string" } },
  adminSchema: {
    settings: { label: "string", internal_note: "string" },
    drafts: { body: "string" },
  },
  // Only `settings.label` crosses to the public side.
  visitorProjection: { settings: ["label"] },
  requestedCapabilities: ["cms_admin_schema"],
  publicOperations: ["save", "read_setting", "read_internal", "write_setting"],
  operations: {
    save: async (ctx, args) => {
      const r = await ctx.query.insert("notes", {
        visitor_id: ctx.visitor.id,
        message: (args as { message: string }).message,
      });
      return { id: r.id };
    },
    // Visitor-facing read of the private storage's projection — the
    // consent-manager `record_consent` shape.
    read_setting: async (ctx) => {
      const q = (ctx as AdminCtx).adminQuery;
      if (!q) throw new Error("ctx.adminQuery missing");
      const rows = await q.list<"settings", { label: string }>("settings", { limit: 1 });
      return { label: rows[0]?.label ?? null, keys: Object.keys(rows[0] ?? {}).sort() };
    },
    read_internal: async (ctx) => {
      const q = (ctx as AdminCtx).adminQuery as PluginAdminQuery;
      return { drafts: await q.list("drafts", { limit: 1 }) };
    },
    write_setting: async (ctx) => {
      const q = (ctx as AdminCtx).adminQuery as PluginAdminQuery;
      await q.insert("settings", { label: "from-a-visitor" });
      return { written: true };
    },
    admin_only: async () => ({ secret: true }),
  },
});

const DECLARATIONS = new Map([[SLUG, { settings: ["label"] }]]);

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

/** The admin publishes (the outbox drain the admin process runs every 2s). */
async function publish(): Promise<void> {
  await drainProjectionOnce(adminAdapter, DECLARATIONS);
  invalidateGatewaySettings();
  invalidateRateLimitSpecCache();
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
  });
  await asPublicAdmin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });
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
  // --- Admin side: register + provision + publish, as the admin host does. ---
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
    await tx.unsafe(
      `INSERT INTO ${SCHEMA}.settings (label, internal_note) VALUES ('from-the-admin', 'private')`,
    );
    await tx.unsafe(`INSERT INTO ${SCHEMA}.drafts (body) VALUES ('unpublished')`);
  }, pluginId);
  await publishProjectionOnce(adminAdapter, { declarations: DECLARATIONS });
  // The admin process goes away; only the gateway's view remains.
  resetPluginHost();

  // --- Gateway side: its real identity, dispatch-only host. ---
  const urls = gatewayDatabaseUrls({ PUBLIC_DATABASE_URL: PUBLIC_URL });
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

describe("the gateway's database identity (#613, #635)", () => {
  it("refuses to start with any admin_role credential in the env", () => {
    for (const name of [
      "ADMIN_DATABASE_URL",
      "ADMIN_DATABASE_PASSWORD",
      "PUBLIC_ADMIN_DATABASE_URL",
      "PUBLIC_ADMIN_DATABASE_PASSWORD",
    ]) {
      expect(() =>
        gatewayDatabaseUrls({
          PUBLIC_DATABASE_URL: "postgres://public_role@h/cms_public",
          [name]: "x",
        }),
      ).toThrow(new RegExp(`must not hold admin_role credentials.*${name}`));
    }
  });

  it("needs only PUBLIC_DATABASE_URL, with its _PASSWORD companion", () => {
    expect(() => gatewayDatabaseUrls({})).toThrow(/PUBLIC_DATABASE_URL/);
    const urls = gatewayDatabaseUrls({
      PUBLIC_DATABASE_URL: "postgresql://public_role@h:5432/cms_public",
      PUBLIC_DATABASE_PASSWORD: "p",
    });
    expect(new URL(urls.public).password).toBe("p");
  });

  it("holds no cms_admin pool: every path to the authoring database throws", async () => {
    expect(gatewayAdapter.hasAdminDatabase).toBe(false);
    expect(() => gatewayAdapter.rawAdmin()).toThrow(AdminDatabaseUnavailableError);
    await expect(
      gatewayAdapter.withAdminTransaction(
        { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t635" },
        async () => "reached",
      ),
    ).rejects.toThrow(AdminDatabaseUnavailableError);
  });

  it("its login is public_role, which cannot even connect to cms_admin", async () => {
    const [who] = (await gatewayAdapter.rawPublic()`SELECT current_user::text AS u`) as {
      u: string;
    }[];
    expect(who?.u).toBe("public_role");
    // Asked of the catalog: Bun's client retries a refused login forever.
    const [can] = (await gatewayAdapter.rawPublic()`
      SELECT has_database_privilege('public_role', 'cms_admin', 'CONNECT') AS c`) as {
      c: boolean;
    }[];
    expect(can?.c).toBe(false);
  });
});

describe("/api/* served from cms_public alone (#635)", () => {
  it("dispatches a visitor write, logs the request and records the op event in cms_public", async () => {
    const r = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "hi" }));
    await expectStatus(r, 200);
    // No consent provider runs here, so nobody has consented to the
    // visitor-id cookie (#677).
    expect(r.headers.get("set-cookie")).toBeNull();
    const { data } = (await r.json()) as { data: { id: string } };
    // The request log write is fire-and-forget; give it a moment.
    await Bun.sleep(200);
    const logged = await asPublicAdmin(
      async (tx) =>
        (await tx`SELECT status_code FROM gateway_request_log WHERE plugin_slug = ${SLUG} AND operation = 'save'`) as {
          status_code: number;
        }[],
    );
    expect(logged.map((l) => l.status_code)).toContain(200);
    const events = await asPublicAdmin(
      async (tx) =>
        (await tx`SELECT operation, entity_id::text AS entity_id FROM gateway_plugin_op_events
                  WHERE plugin_id = ${pluginId}::uuid`) as {
          operation: string;
          entity_id: string;
        }[],
    );
    expect(events).toContainEqual({ operation: `${SLUG}.save`, entity_id: data.id });
    // Nothing of the visitor call landed in the authoring audit trail.
    const audited = await asAdmin(
      async (tx) =>
        (await tx`SELECT a.operation FROM audit_events a JOIN actors ac ON ac.id = a.actor_id
                  WHERE ac.plugin_id = ${pluginId}::uuid`) as { operation: string }[],
    );
    expect(audited.map((a) => a.operation)).not.toContain(`${SLUG}.save`);
  });

  it("a visitor operation reads the declared projection of private storage, nothing more", async () => {
    const r = await handleRequest(post(`/api/plugin/${SLUG}/read_setting`, {}));
    await expectStatus(r, 200);
    const { data } = (await r.json()) as { data: { label: string; keys: string[] } };
    expect(data.label).toBe("from-the-admin");
    // `internal_note` was never published.
    expect(data.keys).toEqual(["id", "label"]);
  });

  it("an undeclared table is unreachable, and private storage is read-only", async () => {
    const internal = await handleRequest(post(`/api/plugin/${SLUG}/read_internal`, {}));
    expect(internal.status).toBe(500);
    expect(await internal.text()).toContain("not in the plugin's visitorProjection");
    const write = await handleRequest(post(`/api/plugin/${SLUG}/write_setting`, {}));
    expect(write.status).toBe(500);
    expect(await write.text()).toContain("cannot write private storage");
  });

  it("follows an admin write through the outbox", async () => {
    await asAdmin(async (tx) => {
      await tx.unsafe(`UPDATE ${SCHEMA}.settings SET label = 'changed-by-the-owner'`);
    }, pluginId);
    await publish();
    const r = await handleRequest(post(`/api/plugin/${SLUG}/read_setting`, {}));
    expect(((await r.json()) as { data: { label: string } }).data.label).toBe(
      "changed-by-the-owner",
    );
  });

  it("a version that drops its declaration withdraws what was published", async () => {
    await publishProjectionOnce(adminAdapter, { declarations: new Map(), comments: false });
    try {
      const r = await handleRequest(post(`/api/plugin/${SLUG}/read_setting`, {}));
      await expectStatus(r, 503);
      const body = (await r.json()) as { error: { kind: string; message: string } };
      expect(body.error.kind).toBe("ProjectionNotPublished");
      expect(body.error.message).toContain(`plugin:${pluginId}`);
      const left = await asPublicAdmin(
        async (tx) =>
          (await tx`SELECT 1 FROM published_plugin_rows WHERE plugin_id = ${pluginId}::uuid`) as unknown[],
      );
      expect(left).toEqual([]);
    } finally {
      await publishProjectionOnce(adminAdapter, { declarations: DECLARATIONS, comments: false });
    }
  });

  it("an unpublished plugin registry is a 503, not 404 PluginNotFound (#635 review)", async () => {
    // A gateway that starts before the admin published the registry knows
    // no plugin at all; "no such plugin" would be a lie.
    resetDispatchOnlyHost();
    await asPublicAdmin(async (tx) => {
      await tx`DELETE FROM published_projection_sections WHERE section = 'plugins'`;
    });
    try {
      await bootstrapDispatchOnly({
        infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
        pluginsRoot: "/dev/null/unused",
        systemActorId: SYSTEM_ACTOR_ID,
        testPlugins: [{ definition: fixture }],
      });
      const r = await handleRequest(post(`/api/plugin/${SLUG}/read_setting`, {}));
      await expectStatus(r, 503);
      const body = (await r.json()) as { error: { kind: string; message: string } };
      expect(body.error.kind).toBe("ProjectionNotPublished");
      expect(body.error.message).toContain('"plugins"');
    } finally {
      await publishProjectionOnce(adminAdapter, { declarations: DECLARATIONS, comments: false });
      resetDispatchOnlyHost();
      const report = await bootstrapDispatchOnly({
        infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
        pluginsRoot: "/dev/null/unused",
        systemActorId: SYSTEM_ACTOR_ID,
        testPlugins: [{ definition: fixture }],
      });
      expect(report.loaded.map((p) => p.slug)).toEqual([SLUG]);
    }
    const r = await handleRequest(post(`/api/plugin/${SLUG}/read_setting`, {}));
    await expectStatus(r, 200);
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

  it("rate limits from a published Owner override", async () => {
    await asAdmin(async (tx) => {
      await tx`INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds)
               VALUES (${SLUG}, 'save', 2, 60)`;
    });
    await publish();
    const header = { "X-Forwarded-For": "203.0.113.200" };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "n" }, header));
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    await asAdmin(async (tx) => {
      await tx`DELETE FROM plugin_rate_limit_overrides WHERE plugin_slug = ${SLUG}`;
    });
    await publish();
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
    await publish();
    try {
      const c = await handleRequest(new Request("http://localhost/api/captcha/challenge"));
      expect(c.status).toBe(200);
      const { challenge, target } = (
        (await c.json()) as { data: { challenge: string; target: string } }
      ).data;
      expect(target).toBe("0");
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
      await publish();
    }
  });

  it("follows the published registry: a disable detaches, a re-activation re-attaches", async () => {
    await asAdmin(async (tx) => {
      await tx`UPDATE plugins SET status = 'disabled' WHERE slug = ${SLUG}`;
    });
    await publish();
    await syncDispatchPlugins({ force: true });
    expect(loadedPlugins.bySlug(SLUG)).toBeUndefined();
    const off = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "x" }));
    await expectStatus(off, 404);

    await asAdmin(async (tx) => {
      await tx`UPDATE plugins SET status = 'active' WHERE slug = ${SLUG}`;
    });
    await publish();
    await syncDispatchPlugins({ force: true });
    const on = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "x" }));
    await expectStatus(on, 200);
    // The plugin's projection came back with it.
    const read = await handleRequest(post(`/api/plugin/${SLUG}/read_setting`, {}));
    await expectStatus(read, 200);
  });
});

describe("the public side cannot rewrite what the admin published (#635, adversarial)", () => {
  /** Run `query` as public_role (the gateway's login); resolve to the error text or "ok". */
  async function attempt(query: ReturnType<typeof sql>, pluginScope?: string): Promise<string> {
    try {
      await gatewayAdapter.withPublicTransaction(
        {
          actorId: SYSTEM_ACTOR_ID,
          actorKind: "system",
          requestId: "t635",
          ...(pluginScope ? { pluginId: pluginScope } : {}),
        },
        async (tx) => tx.execute(query),
      );
      return "ok";
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
    }
  }

  it("cannot write any published table", async () => {
    for (const q of [
      sql`UPDATE published_gateway_settings SET max_body_bytes = 1`,
      sql`DELETE FROM published_plugins`,
      sql`INSERT INTO published_rate_limits VALUES ('x', 'y', 1, 1)`,
      sql`UPDATE published_staging_access SET ip_allowlist = '["0.0.0.0/0"]'`,
      sql`DELETE FROM published_projection_sections`,
      sql`DELETE FROM published_comments`,
    ]) {
      expect(await attempt(q)).toMatch(/permission denied/);
    }
  });

  it("reads a plugin's projected rows only under that plugin's id", async () => {
    const rows = await gatewayAdapter.withPublicTransaction(
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t635" },
      async (tx) => (await tx.execute(sql`SELECT * FROM published_plugin_rows`)) as unknown[],
    );
    expect(rows).toEqual([]);
  });

  it("cannot choose an op event's id or time: the watermark cannot be pushed past real events", async () => {
    const forged = sql`INSERT INTO gateway_plugin_op_events (id, plugin_id, operation, input_hash, succeeded)
      VALUES (9223372036854775807, ${pluginId}::uuid, 't635-gw.save', ${"a".repeat(64)}, true)`;
    expect(await attempt(forged)).toMatch(/permission denied/);
    const backdated = sql`INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, created_at)
      VALUES (${pluginId}::uuid, 't635-gw.save', ${"a".repeat(64)}, true, now() - interval '1 day')`;
    expect(await attempt(backdated)).toMatch(/permission denied/);
    expect(
      await attempt(sql`SELECT setval('gateway_plugin_op_events_id_seq', 9000000000)`),
    ).toMatch(/permission denied/);
    const legit = sql`INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded)
      VALUES (${pluginId}::uuid, 't635-gw.save', ${"a".repeat(64)}, true)`;
    expect(await attempt(legit)).toBe("ok");
  });

  it("cannot read back its own request log or op events", async () => {
    expect(await attempt(sql`SELECT * FROM gateway_request_log`)).toMatch(/permission denied/);
    expect(await attempt(sql`SELECT * FROM gateway_plugin_op_events`)).toMatch(/permission denied/);
  });

  it("a section the admin never published is a loud 503, not an empty answer", async () => {
    await asPublicAdmin(async (tx) => {
      await tx`DELETE FROM published_projection_sections WHERE section = 'settings'`;
      await tx`DELETE FROM published_gateway_settings`;
    });
    invalidateGatewaySettings();
    try {
      const r = await handleRequest(post(`/api/plugin/${SLUG}/save`, { message: "x" }));
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("has not published the gateway settings");
    } finally {
      await publishProjectionOnce(adminAdapter, { declarations: DECLARATIONS, comments: false });
      invalidateGatewaySettings();
    }
  });
});

describe("staging.<domain> from the published gate settings (#650, #635)", () => {
  const STAGING = "https://staging.example.com";
  const PREVIEW = "https://site--runid-t650-x1.web.app";
  const SECRET = "t650-gate-secret";

  it("reads the published gate settings + origin and proxies an admitted request", async () => {
    const saved = {
      provider: process.env.CAELO_PROVIDER,
      secret: process.env.CAELO_STAGING_GATE_SECRET,
    };
    const realFetch = globalThis.fetch;
    process.env.CAELO_PROVIDER = "gcp-firebase";
    process.env.CAELO_STAGING_GATE_SECRET = SECRET;
    await asAdmin(async (tx) => {
      await tx`UPDATE staging_access SET origin_url = ${PREVIEW}, cookie_enabled = true,
                 staging_host = 'staging.example.com' WHERE id = 1`;
    });
    await publish();
    const upstream: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Compare the parsed origin exactly: a prefix test would also match
      // `https://site--runid-t650-x1.web.app.evil.example`.
      if (new URL(url).origin !== PREVIEW) return realFetch(input, init);
      upstream.push(url);
      return new Response("<h1>staged</h1>", { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    try {
      const denied = await handleRequest(
        new Request(`${STAGING}/about/`, { headers: { host: "staging.example.com" } }),
      );
      expect(denied.status).toBe(403);
      const session = await signStagingToken(SECRET, "session", Math.floor(Date.now() / 1000) + 60);
      const allowed = await handleRequest(
        new Request(`${STAGING}/about/`, {
          headers: { host: "staging.example.com", cookie: `${STAGING_SESSION_COOKIE}=${session}` },
        }),
      );
      await expectStatus(allowed, 200);
      expect(await allowed.text()).toBe("<h1>staged</h1>");
      expect(allowed.headers.get("x-robots-tag")).toBe("noindex");
      expect(upstream).toEqual([`${PREVIEW}/about/`]);
    } finally {
      globalThis.fetch = realFetch;
      if (saved.provider === undefined) delete process.env.CAELO_PROVIDER;
      else process.env.CAELO_PROVIDER = saved.provider;
      if (saved.secret === undefined) delete process.env.CAELO_STAGING_GATE_SECRET;
      else process.env.CAELO_STAGING_GATE_SECRET = saved.secret;
      await asAdmin(async (tx) => {
        await tx`UPDATE staging_access SET origin_url = NULL, staging_host = NULL WHERE id = 1`;
      });
      await publish();
    }
  });
});
