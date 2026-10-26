// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #677 — the gateway sets `caelo_visitor_id` only for a plugin that
 * declares the `visitor_id` consent purpose (ratings, under `functional`)
 * and only with the visitor's consent to that category, read the way the
 * consent-manager plugin defines it.
 *
 * Production wiring: the real consent-manager and ratings plugins are
 * registered + provisioned by an admin-side host, then served by the
 * dispatch-only host as public_role (no cms_admin login, #635), from the
 * projection the admin publishes. Each case is one
 * visitor state the banner can leave behind:
 *
 *   - no decision yet           → no cookie, plugins see no id
 *   - "reject all"              → no cookie, even on record_consent itself
 *   - accepted (functional)     → cookie minted, then recognised
 *   - analytics/marketing only  → no cookie: not the declared category
 *   - withdrawn after accepting → cookie expired, id no longer read
 *   - decision under an old policy version → counts as no decision
 *   - provider unable to answer → 503, never a guess
 *   - no active plugin declares the purpose → never set, a held one expired
 *
 * Plus what no longer depends on the cookie: rate limits are per client
 * address and a captcha challenge is bound to nobody.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drainProjectionOnce, publishProjectionOnce } from "@caelo-cms/admin-core";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import {
  bootstrap,
  bootstrapDispatchOnly,
  registerGatewayOperations,
  resetDispatchOnlyHost,
  resetPluginHost,
  syncDispatchPlugins,
} from "@caelo-cms/plugin-host";
import ratingsPlugin from "@caelo-cms/plugin-ratings";
import { definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
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
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL, PUBLIC_ADMIN_DATABASE_URL and PUBLIC_DATABASE_URL are required",
  );
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUGS = ["consent-manager", "ratings", "visitor-echo"] as const;

/**
 * A plugin that declares no consent purpose and answers with the visitor
 * id it was handed: the id must reach only the plugin that asked for it.
 */
const echoPlugin = definePlugin<PluginContextTier1>({
  slug: "visitor-echo",
  version: "0.0.1",
  tier: 1,
  schema: {},
  publicOperations: ["whoami"],
  operations: {
    whoami: async (ctx) => ({ visitorId: ctx.visitor.id }),
  },
});
const RECORD = "/api/plugin/consent-manager/record_consent";
/** The random id the banner keeps in caelo_consent and posts with every decision. */
const CONSENT_ID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const RATE = "/api/plugin/ratings/submit";

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let pluginIds: Record<string, string> = {};
let savedCaptcha: { provider: string; prefix: string } | null = null;

async function asAdmin<T>(fn: (tx: SQL) => Promise<T>, pluginSlug?: string): Promise<T> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // A plugin's private tables are RLS-scoped to its plugin id.
      if (pluginSlug) {
        await tx`SELECT set_config('caelo.plugin_id', ${pluginIds[pluginSlug] ?? ""}, true)`;
      }
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

/** Rows of one plugin's cms_public table, read in that plugin's RLS scope. */
async function publicRows<T>(slug: string, table: string): Promise<T[]> {
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    return (await pub.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
      await tx.unsafe(`SET LOCAL caelo.plugin_id = '${pluginIds[slug]}'`);
      return tx.unsafe(
        `SELECT * FROM "plugin_${slug.replace(/-/g, "_")}"."${table}" ORDER BY created_at`,
      );
    })) as T[];
  } finally {
    await pub.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  resetDispatchOnlyHost();
  await asAdmin(async (tx) => {
    for (const slug of SLUGS) {
      const schema = `plugin_${slug.replace(/-/g, "_")}`;
      await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
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

async function setCaptcha(provider: "off" | "pow"): Promise<void> {
  await asAdmin(async (tx) => {
    await tx`UPDATE site_settings SET captcha_provider = ${provider}, captcha_pow_target_prefix = '0' WHERE id = 1`;
  });
  await publish();
}

/** Consent-manager's declared projection: what the admin publishes of its private storage. */
const DECLARATIONS = new Map([["consent-manager", consentPlugin.visitorProjection ?? {}]]);

/** The admin's outbox drain (#635): publish what changed, then the gateway drops its caches. */
async function publish(): Promise<void> {
  await drainProjectionOnce(adminAdapter, DECLARATIONS);
  invalidateGatewaySettings();
}

/** What the Owner's `bump_policy_version` writes, set directly. */
async function setPolicyVersion(version: number): Promise<void> {
  const updated = await asAdmin(
    async (tx) =>
      (await tx`UPDATE plugin_consent_manager.settings SET policy_version = ${version} RETURNING id`) as unknown[],
    "consent-manager",
  );
  expect(updated).toHaveLength(1);
  await publish();
}

/** The `caelo_consent` cookie exactly as the consent runtime writes it. */
function consentCookie(granted: string[], policyVersion = 1): string {
  return `caelo_consent=${encodeURIComponent(
    JSON.stringify({ granted, policyVersion, at: new Date().toISOString() }),
  )}`;
}

let clientIp = 0;

/** A visitor POST from its own client IP, carrying `cookies`. */
function post(path: string, body: unknown, cookies: string[] = []): Request {
  clientIp++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Forwarded-For": `192.0.2.${clientIp % 250}`,
  };
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** A visitor POST from a fixed client address, carrying `cookies`. */
function postFrom(ip: string, path: string, body: unknown, cookies: string[] = []): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Forwarded-For": ip,
  };
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** A captcha challenge request from its own client IP, carrying `cookies`. */
function challengeReq(cookies: string[] = []): Request {
  clientIp++;
  const headers: Record<string, string> = { "X-Forwarded-For": `192.0.2.${clientIp % 250}` };
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  return new Request("http://localhost/api/captcha/challenge", { headers });
}

/** Fetch a challenge as `cookies`' visitor and solve it, as the component kit does. */
async function solvedProof(cookies: string[]): Promise<{ challenge: string; nonce: string }> {
  const c = await handleRequest(challengeReq(cookies));
  await expectStatus(c, 200);
  const { challenge, target } = (
    (await c.json()) as { data: { challenge: string; target: string } }
  ).data;
  for (let nonce = 0; ; nonce++) {
    const hex = new Bun.CryptoHasher("sha256").update(`${challenge}${nonce}`).digest("hex");
    if (hex.startsWith(target)) return { challenge, nonce: String(nonce) };
  }
}

async function expectStatus(r: Response, status: number): Promise<void> {
  if (r.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${r.status}: ${await r.clone().text()}`);
  }
}

/** The signed visitor cookie a response set, or null. */
function mintedVisitorCookie(r: Response): string | null {
  for (const c of r.headers.getSetCookie()) {
    const value = parseCookies(c.split(";")[0] ?? null).caelo_visitor_id;
    if (value) return value;
  }
  return null;
}

function expectsNoVisitorCookie(r: Response): void {
  for (const c of r.headers.getSetCookie()) {
    expect(c.startsWith("caelo_visitor_id=") && !c.startsWith("caelo_visitor_id=;")).toBe(false);
  }
}

function expectsVisitorCookieExpired(r: Response): void {
  const cleared = r.headers.getSetCookie().filter((c) => c.startsWith("caelo_visitor_id=;"));
  expect(cleared).toHaveLength(1);
  expect(cleared[0]).toContain("Max-Age=0");
}

const DECLINED = consentCookie(["necessary"]);
const ACCEPTED = consentCookie(["necessary", "functional", "analytics", "marketing"]);

beforeAll(async () => {
  // Behind one proxy (self-hosted Caddy sets X-Forwarded-For to its peer).
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

  // --- Admin side: register, provision and activate (consent-manager's
  // onActivate seeds its categories and policy version 1). ---
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
      { definition: echoPlugin },
    ],
  });
  expect(adminReport.failed).toEqual([]);
  await publishProjectionOnce(adminAdapter, { declarations: DECLARATIONS });
  resetPluginHost();
  pluginIds = await asAdmin(async (tx) => {
    const rows =
      (await tx`SELECT slug, id::text AS id FROM plugins WHERE slug IN ('consent-manager', 'ratings')`) as {
        slug: string;
        id: string;
      }[];
    return Object.fromEntries(rows.map((r) => [r.slug, r.id]));
  });

  // --- Gateway side: production wiring. ---
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
  invalidateRateLimitSpecCache();
  const report = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [
      { definition: consentPlugin },
      { definition: ratingsPlugin },
      { definition: echoPlugin },
    ],
  });
  expect(report.failed).toEqual([]);
  // Ratings asks for a captcha proof; the proof path has its own tests.
  await setCaptcha("off");
});

afterAll(async () => {
  await asAdmin(async (tx) => {
    await tx`UPDATE site_settings SET captcha_provider = ${savedCaptcha?.provider ?? "pow"},
             captcha_pow_target_prefix = ${savedCaptcha?.prefix ?? "000fff"} WHERE id = 1`;
  });
  await publish();
  await cleanup();
  await gatewayAdapter.close();
  await adminAdapter.close();
});

describe("no consent decision yet (#677)", () => {
  it("sets no visitor cookie and hands the plugin no id", async () => {
    const r = await handleRequest(post(RATE, { pageId: "p-none", score: 4 }));
    await expectStatus(r, 200);
    expect(r.headers.getSetCookie()).toEqual([]);
    const rows = await publicRows<{ page_id: string; visitor_id: string | null }>(
      "ratings",
      "ratings",
    );
    expect(rows.filter((x) => x.page_id === "p-none").map((x) => x.visitor_id)).toEqual([null]);
  });

  it("sets no visitor cookie on a captcha challenge either", async () => {
    await setCaptcha("pow");
    try {
      const r = await handleRequest(challengeReq());
      await expectStatus(r, 200);
      expect(r.headers.getSetCookie()).toEqual([]);
    } finally {
      await setCaptcha("off");
    }
  });
});

describe("rejected (#677)", () => {
  it("records the rejection without setting or storing a visitor id", async () => {
    const r = await handleRequest(
      post(RECORD, { consentId: CONSENT_ID, granted: ["necessary"], policyVersion: 1 }, [DECLINED]),
    );
    await expectStatus(r, 200);
    expect(r.headers.getSetCookie()).toEqual([]);
    const log = await publicRows<{ consent_id: string; granted: string[] }>(
      "consent-manager",
      "consent_log",
    );
    const last = log.at(-1);
    expect(last?.granted).toEqual(["necessary"]);
    expectsOnlyTheConsentId(last);
  });

  it("keeps a rejecting visitor's ratings unlinked, one row per vote", async () => {
    for (const score of [2, 5]) {
      const r = await handleRequest(post(RATE, { pageId: "p-rejected", score }, [DECLINED]));
      await expectStatus(r, 200);
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(((await r.json()) as { data: { mode: string } }).data.mode).toBe("inserted");
    }
  });
});

describe("accepted, then withdrawn (#677)", () => {
  let visitorCookie = "";

  it("mints the visitor cookie with the decision that grants functional", async () => {
    const r = await handleRequest(
      post(
        RECORD,
        {
          consentId: CONSENT_ID,
          granted: ["necessary", "functional", "analytics", "marketing"],
          policyVersion: 1,
        },
        [ACCEPTED],
      ),
    );
    await expectStatus(r, 200);
    visitorCookie = mintedVisitorCookie(r) ?? "";
    expect(visitorCookie).not.toBe("");
    const set = r.headers.getSetCookie().find((c) => c.startsWith("caelo_visitor_id="));
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Max-Age=2592000");
    // The visitor id is ratings' purpose, not proof of consent: the record
    // keeps the banner's own id even when the decision mints the cookie.
    const log = await publicRows<{ consent_id: string }>("consent-manager", "consent_log");
    expectsOnlyTheConsentId(log.at(-1));
  });

  it("recognises the visitor afterwards: no new cookie, their vote is updated", async () => {
    const cookies = [ACCEPTED, `caelo_visitor_id=${visitorCookie}`];
    const first = await handleRequest(post(RATE, { pageId: "p-accepted", score: 3 }, cookies));
    await expectStatus(first, 200);
    expect(first.headers.getSetCookie()).toEqual([]);
    expect(((await first.json()) as { data: { mode: string } }).data.mode).toBe("inserted");
    const second = await handleRequest(post(RATE, { pageId: "p-accepted", score: 1 }, cookies));
    await expectStatus(second, 200);
    expect(((await second.json()) as { data: { mode: string } }).data.mode).toBe("updated");
  });

  it("hands the id only to the plugin that declared it, not to every plugin", async () => {
    const r = await handleRequest(
      post("/api/plugin/visitor-echo/whoami", {}, [ACCEPTED, `caelo_visitor_id=${visitorCookie}`]),
    );
    await expectStatus(r, 200);
    expect(((await r.json()) as { data: { visitorId: string | null } }).data.visitorId).toBeNull();
  });

  it("expires the cookie when the visitor withdraws, and stops reading it", async () => {
    // The banner rewrote caelo_consent; the HttpOnly id is still in the
    // browser until the gateway expires it — on the record_consent beacon.
    const r = await handleRequest(
      post(RECORD, { consentId: CONSENT_ID, granted: ["necessary"], policyVersion: 1 }, [
        DECLINED,
        `caelo_visitor_id=${visitorCookie}`,
      ]),
    );
    await expectStatus(r, 200);
    expectsVisitorCookieExpired(r);
    const log = await publicRows<{ consent_id: string }>("consent-manager", "consent_log");
    expectsOnlyTheConsentId(log.at(-1));

    // A browser that still sends it (the expiry not applied yet) is not
    // recognised: the earlier vote is not found and updated.
    const vote = await handleRequest(
      post(RATE, { pageId: "p-accepted", score: 5 }, [
        DECLINED,
        `caelo_visitor_id=${visitorCookie}`,
      ]),
    );
    await expectStatus(vote, 200);
    expectsVisitorCookieExpired(vote);
    expect(((await vote.json()) as { data: { mode: string } }).data.mode).toBe("inserted");
  });
});

describe("a decision without the declared category", () => {
  it("sets no visitor cookie when the visitor granted analytics and marketing but not functional", async () => {
    const r = await handleRequest(
      post(RATE, { pageId: "p-analytics", score: 4 }, [
        consentCookie(["necessary", "analytics", "marketing"]),
      ]),
    );
    await expectStatus(r, 200);
    expect(r.headers.getSetCookie()).toEqual([]);
  });
});

describe("a decision under an outdated policy version (#677)", () => {
  it("counts as no decision: no cookie minted, a held one expired", async () => {
    const minted = mintedVisitorCookie(
      await handleRequest(post(RATE, { pageId: "p-policy", score: 4 }, [ACCEPTED])),
    );
    expect(minted).not.toBeNull();
    await setPolicyVersion(2);
    try {
      const fresh = await handleRequest(post(RATE, { pageId: "p-policy", score: 4 }, [ACCEPTED]));
      await expectStatus(fresh, 200);
      expectsNoVisitorCookie(fresh);
      const held = await handleRequest(
        post(RATE, { pageId: "p-policy", score: 4 }, [ACCEPTED, `caelo_visitor_id=${minted}`]),
      );
      await expectStatus(held, 200);
      expectsVisitorCookieExpired(held);
      // Re-consenting under the current version counts again.
      const renewed = await handleRequest(
        post(RATE, { pageId: "p-policy", score: 4 }, [consentCookie(["functional"], 2)]),
      );
      expect(mintedVisitorCookie(renewed)).not.toBeNull();
    } finally {
      await setPolicyVersion(1);
    }
  });
});

describe("a consent provider that cannot answer (#677)", () => {
  it("answers 503 ConsentUnavailable instead of guessing, and sets no cookie", async () => {
    // Its settings row is what `visitor_consent_rule` reads; without it the
    // provider is running but cannot say which policy version counts.
    const saved = await asAdmin(
      async (tx) =>
        (await tx`DELETE FROM plugin_consent_manager.settings RETURNING to_jsonb(settings.*)::text AS row`) as {
          row: string;
        }[],
      "consent-manager",
    );
    expect(saved).toHaveLength(1);
    await publish();
    try {
      const r = await handleRequest(post(RATE, { pageId: "p-broken", score: 4 }, [ACCEPTED]));
      await expectStatus(r, 503);
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(((await r.json()) as { error: { kind: string } }).error.kind).toBe(
        "ConsentUnavailable",
      );
    } finally {
      await asAdmin(async (tx) => {
        await tx`INSERT INTO plugin_consent_manager.settings
                 SELECT * FROM jsonb_populate_record(NULL::plugin_consent_manager.settings, (${saved[0]?.row ?? ""}::text)::jsonb)`;
      }, "consent-manager");
      await publish();
    }
  });
});

/** A consent record holds the banner's consent id and no visitor or address data. */
function expectsOnlyTheConsentId(row: Record<string, unknown> | undefined): void {
  expect(row?.consent_id).toBe(CONSENT_ID);
  expect(Object.keys(row ?? {})).not.toContain("visitor_id");
  expect(Object.keys(row ?? {})).not.toContain("ip_hash");
}

/** A consented visitor's signed id cookie, minted on the consent beacon. */
async function consentedVisitor(): Promise<string> {
  const r = await handleRequest(
    post(
      RECORD,
      {
        consentId: CONSENT_ID,
        granted: ["necessary", "functional", "analytics", "marketing"],
        policyVersion: 1,
      },
      [ACCEPTED],
    ),
  );
  await expectStatus(r, 200);
  const cookie = mintedVisitorCookie(r);
  if (!cookie) throw new Error("no visitor cookie minted");
  return `caelo_visitor_id=${cookie}`;
}

describe("a captcha challenge is bound to nobody", () => {
  it("is redeemable once by whichever request presents it, with or without a visitor cookie", async () => {
    const alice = [ACCEPTED, await consentedVisitor()];
    const bob = [ACCEPTED, await consentedVisitor()];
    await setCaptcha("pow");
    try {
      // Issued to Alice's browser, presented by Bob's: the work was done,
      // and that is the protection — the cookie never was one.
      const proof = await solvedProof(alice);
      const bobs = await handleRequest(
        post(RATE, { pageId: "p-unbound", score: 4, _caelo_captcha: proof }, bob),
      );
      await expectStatus(bobs, 200);
      // Single use: Alice cannot redeem it after him.
      const replay = await handleRequest(
        post(RATE, { pageId: "p-unbound", score: 4, _caelo_captcha: proof }, alice),
      );
      await expectStatus(replay, 403);
      expect(await replay.text()).toContain("already used");
      // A visitor without any cookie solves and redeems their own.
      const anon = await solvedProof([]);
      const anons = await handleRequest(
        post(RATE, { pageId: "p-unbound", score: 3, _caelo_captcha: anon }, []),
      );
      await expectStatus(anons, 200);
    } finally {
      await setCaptcha("off");
    }
  });
});

describe("rate limits are per client address, never per visitor cookie", () => {
  it("throttles one address whatever cookie each request carries", async () => {
    await asAdmin(async (tx) => {
      await tx`INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds)
               VALUES ('ratings', 'submit', 2, 60)
               ON CONFLICT (plugin_slug, operation) DO UPDATE SET per_visitor_max = 2, window_seconds = 60`;
    });
    await publish();
    invalidateRateLimitSpecCache();
    try {
      const ip = "198.51.100.77";
      const alice = [ACCEPTED, await consentedVisitor()];
      const bob = [ACCEPTED, await consentedVisitor()];
      await expectStatus(
        await handleRequest(postFrom(ip, RATE, { pageId: "p-rl", score: 1 }, alice)),
        200,
      );
      await expectStatus(
        await handleRequest(postFrom(ip, RATE, { pageId: "p-rl", score: 2 }, bob)),
        200,
      );
      // A third request from the same address: a fresh cookie, none at all,
      // or a recognised one — the budget is the address's, so all are refused.
      for (const cookies of [[], [ACCEPTED], alice]) {
        const r = await handleRequest(postFrom(ip, RATE, { pageId: "p-rl", score: 3 }, cookies));
        await expectStatus(r, 429);
      }
      // Another address has its own budget.
      await expectStatus(
        await handleRequest(postFrom("198.51.100.78", RATE, { pageId: "p-rl", score: 4 }, alice)),
        200,
      );
    } finally {
      await asAdmin(async (tx) => {
        await tx`DELETE FROM plugin_rate_limit_overrides WHERE plugin_slug = 'ratings' AND operation = 'submit'`;
      });
      await publish();
      invalidateRateLimitSpecCache();
    }
  });
});

describe("no active plugin declares the visitor-id purpose", () => {
  it("never sets the cookie, and expires one the browser still holds", async () => {
    const held = await consentedVisitor();
    // The Owner switches ratings — the only declaring plugin — off.
    await asAdmin(async (tx) => {
      await tx`UPDATE plugins SET status = 'disabled' WHERE slug = 'ratings'`;
    });
    await publish();
    await syncDispatchPlugins({ force: true });
    try {
      const fresh = await handleRequest(
        post(
          RECORD,
          {
            consentId: CONSENT_ID,
            granted: ["necessary", "functional", "analytics", "marketing"],
            policyVersion: 1,
          },
          [ACCEPTED],
        ),
      );
      await expectStatus(fresh, 200);
      expect(fresh.headers.getSetCookie()).toEqual([]);
      const log = await publicRows<{ consent_id: string }>("consent-manager", "consent_log");
      expectsOnlyTheConsentId(log.at(-1));

      const stale = await handleRequest(
        post(
          RECORD,
          {
            consentId: CONSENT_ID,
            granted: ["necessary", "functional", "analytics", "marketing"],
            policyVersion: 1,
          },
          [ACCEPTED, held],
        ),
      );
      await expectStatus(stale, 200);
      expectsVisitorCookieExpired(stale);
    } finally {
      await asAdmin(async (tx) => {
        await tx`UPDATE plugins SET status = 'active' WHERE slug = 'ratings'`;
      });
      await publish();
      await syncDispatchPlugins({ force: true });
    }
    // Back on: the declaration returns and with it the cookie.
    expect(await consentedVisitor()).toStartWith("caelo_visitor_id=");
  });
});
