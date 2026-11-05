// SPDX-License-Identifier: MPL-2.0

/**
 * #1432 — an unsubscribe link end to end, from the mail the admin sends to
 * the gateway's two ways in.
 *
 * The admin side sends a mail through `ctx.email` with a stubbed transport;
 * the link in it then goes through `handleRequest` with the gateway's real
 * identity (public_role, no cms_admin pool). Proves that the link is
 * absolute and carries the RFC 8058 headers, that opening it changes
 * nothing, that a one-click POST unsubscribes with nothing but the token,
 * and that a token cannot be forged, reused for someone else or used to
 * reach another operation without a proof-of-work.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { releaseProjectionForTests, stagingPublicAdapter } from "@caelo-cms/admin-core";
import {
  bootstrap,
  bootstrapDispatchOnly,
  resetDispatchOnlyHost,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import {
  definePlugin,
  mailUnsubscribeRecipient,
  type PluginContextTier1,
  z,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
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
const STAGING_URL = process.env.PUBLIC_STAGING_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL || !STAGING_URL || !STAGING_ADMIN_URL) {
  throw new Error("the admin, public and staging database URLs are required");
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t1432-mail";
const SCHEMA = "plugin_t1432_mail";
const LIVE_HOST = "https://www.t1432.test";

const tokenInput = z.object({ token: z.string().min(16).max(128) }).strict();

const fixture = definePlugin<PluginContextTier1>({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: {
    recipients: {
      id: "uuid",
      unsub_token: "string",
      unsubscribed_at: "timestamp_nullable",
    },
  },
  tableKinds: { recipients: "visitor-state" },
  indexes: { schema: { recipients: [["unsub_token"]] } },
  requires: ["email"],
  requestedCapabilities: ["email"],
  mailUnsubscribe: { operation: "leave", label: "Unsubscribe", done: "You are out." },
  publicOperations: [
    {
      name: "leave",
      kind: "write",
      input: tokenInput,
      rateLimit: { max: 3, windowSeconds: 60 },
      reads: ["recipients"],
      writes: ["recipients"],
    },
    { name: "other", kind: "write", input: tokenInput },
  ],
  operations: {
    other: async () => ({ ran: true }),
    leave: async (ctx, args) => {
      const id = mailUnsubscribeRecipient((args as { token: string }).token);
      const rows = await ctx.query.list<"recipients", { id: string }>("recipients", {
        unsub_token: id as string,
        limit: 1,
      });
      if (rows[0]) {
        await ctx.query.update("recipients", rows[0].id, {
          unsubscribed_at: new Date().toISOString(),
        });
      }
      return { left: true };
    },
    mail_with_link: async (ctx, args) => {
      await ctx.email?.send({
        to: "reader@t1432.test",
        subject: "News",
        html: "<p>News</p>",
        unsubscribeUrl: (args as { url: string }).url,
      });
      return {};
    },
    mail_one: async (ctx, args) => {
      const { recipientId } = args as { recipientId: string };
      const url = await ctx.email?.unsubscribeLink({ recipientId });
      await ctx.email?.send({
        to: "reader@t1432.test",
        subject: "News",
        html: `<a href="${url}">Unsubscribe</a>`,
        unsubscribeUrl: url,
      });
      return { url };
    },
  },
});

interface SentMail {
  readonly html: string;
  readonly headers?: Readonly<Record<string, string>>;
}

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
const stagingAdapter = stagingPublicAdapter(STAGING_ADMIN_URL);
const sent: SentMail[] = [];

/** Run `fn` on cms_public as the admin, scoped to the fixture plugin. */
async function asPlugin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const admin = new SQL(ADMIN_URL as string);
  const db = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    const pluginId = await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as {
        id: string;
      }[];
      return rows[0]?.id as string;
    });
    return (await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`SELECT set_config('caelo.plugin_id', ${pluginId}, true)`;
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await admin.end();
    await db.end();
  }
}

async function unsubscribedAt(recipientId: string): Promise<string | null> {
  return asPlugin(async (tx) => {
    const rows = (await tx.unsafe(
      `SELECT unsubscribed_at FROM ${SCHEMA}.recipients WHERE unsub_token = $1`,
      [recipientId],
    )) as { unsubscribed_at: string | null }[];
    return rows[0]?.unsubscribed_at ?? null;
  });
}

async function addRecipient(): Promise<string> {
  const id = crypto.randomUUID();
  await asPlugin((tx) =>
    tx.unsafe(`INSERT INTO ${SCHEMA}.recipients (unsub_token) VALUES ($1)`, [id]),
  );
  return id;
}

/** The link of a mail to `recipientId`, as the admin sends it. */
async function mailLink(recipientId: string): Promise<string> {
  resetDispatchOnlyHost();
  await adminHost();
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: SLUG,
    operationName: "mail_one",
    args: { recipientId },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  await gatewayHost();
  return (r.value as { url: string }).url;
}

/** The key where the admin holds it: cms_admin, never the public side. */
async function adminKey(): Promise<string | null> {
  const db = new SQL(ADMIN_URL as string);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`SELECT mail_link_key FROM site_settings WHERE id = 1`) as {
        mail_link_key: string | null;
      }[];
      return rows[0]?.mail_link_key ?? null;
    });
  } finally {
    await db.end();
  }
}

async function adminHost(origin: string | null = LIVE_HOST): Promise<void> {
  const report = await bootstrap({
    infra: {
      adapter: adminAdapter,
      registry: new OperationRegistry(),
      mailLinks: async () => ({ origin, key: await adminKey() }),
      emailTransport: {
        send: async (m) => {
          sent.push(m);
          return { messageId: "m" };
        },
      },
    },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: fixture }],
  });
  expect(report.failed).toEqual([]);
}

async function gatewayHost(): Promise<void> {
  resetPluginHost();
  const report = await bootstrapDispatchOnly({
    infra: {
      adapter: gatewayAdapter,
      registry: new OperationRegistry(),
      mailLinks: gatewayMailLinks,
    },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: fixture }],
  });
  expect(report.failed).toEqual([]);
}

let clientIp = 0;
function nextClient(): string {
  clientIp += 1;
  return `203.0.${Math.floor(clientIp / 250)}.${clientIp % 250}`;
}

/** What a mail client sends for the one-click button: no cookie, no Origin. */
function oneClick(
  link: string,
  init: { body?: BodyInit; contentType?: string | null; client?: string } = {},
): Promise<Response> {
  const contentType =
    init.contentType === undefined ? "application/x-www-form-urlencoded" : init.contentType;
  return handleRequest(
    new Request(link, {
      method: "POST",
      headers: {
        ...(contentType ? { "Content-Type": contentType } : {}),
        "X-Forwarded-For": `${init.client ?? nextClient()}, 34.120.0.1`,
      },
      body: init.body ?? "List-Unsubscribe=One-Click",
    }),
  );
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  resetDispatchOnlyHost();
  const admin = new SQL(ADMIN_URL as string);
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    });
  } finally {
    await admin.end();
  }
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    await pub.end();
  }
}

beforeAll(async () => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "2";
  await cleanup();
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  await adminHost();
  await registerTestLiveOrigin(ADMIN_URL as string);
  await releaseProjectionForTests(adminAdapter, stagingAdapter, new Map([[SLUG, {}]]));
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
  await gatewayHost();
});

afterAll(async () => {
  await cleanup();
  await gatewayAdapter.close();
  await adminAdapter.close();
});

beforeEach(() => {
  sent.length = 0;
});

describe("the mail (#1432)", () => {
  it("carries an absolute link on the live host and the RFC 8058 headers", async () => {
    const id = await addRecipient();
    const url = await mailLink(id);
    expect(url).toStartWith(`${LIVE_HOST}/api/_caelo/mail-link/${SLUG}/leave?token=${id}_`);
    expect(sent[0]?.headers).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("is refused without a base URL, naming the setting", async () => {
    resetPluginHost();
    await adminHost(null);
    const r = await runPluginOperation({
      invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
      pluginSlug: SLUG,
      operationName: "mail_one",
      args: { recipientId: crypto.randomUUID() },
    });
    resetPluginHost();
    await gatewayHost();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("no base URL");
    expect(sent).toEqual([]);
  });
});

describe("a link a plugin altered (#1432)", () => {
  it("never becomes a mail header: not on another host, not with an unsigned token", async () => {
    const id = await addRecipient();
    const url = await mailLink(id);
    sent.length = 0;
    resetDispatchOnlyHost();
    await adminHost();
    const attempts = [
      url.replace(LIVE_HOST, "https://evil.example"),
      url.replace(/_[A-Za-z0-9_-]{43}$/, `_${"A".repeat(43)}`),
    ];
    for (const altered of attempts) {
      const r = await runPluginOperation({
        invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
        pluginSlug: SLUG,
        operationName: "mail_with_link",
        args: { url: altered },
      });
      expect(r.ok).toBe(false);
    }
    await gatewayHost();
    expect(sent).toEqual([]);
  });
});

describe("opening the link (#1432)", () => {
  it("shows the page, reflects no token and changes nothing, however often a scanner opens it", async () => {
    const id = await addRecipient();
    const url = await mailLink(id);
    for (let i = 0; i < 3; i++) {
      const r = await handleRequest(
        new Request(url, { headers: { "X-Forwarded-For": `${nextClient()}, 34.120.0.1` } }),
      );
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain("Unsubscribe");
      expect(html).not.toContain(id);
    }
    expect(await unsubscribedAt(id)).toBeNull();
  });

  it("serves no page for an operation that is not the declared link", async () => {
    const r = await handleRequest(
      new Request(`${LIVE_HOST}/api/_caelo/mail-link/${SLUG}/other?token=x`, {
        headers: { "X-Forwarded-For": `${nextClient()}, 34.120.0.1` },
      }),
    );
    expect(r.status).toBe(404);
  });
});

describe("one-click (RFC 8058, #1432)", () => {
  it("unsubscribes with a form body and nothing else, and sets no cookie", async () => {
    const id = await addRecipient();
    const r = await oneClick(await mailLink(id));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await unsubscribedAt(id)).not.toBeNull();
  });

  it("takes the multipart form too, and a second POST is a success", async () => {
    const id = await addRecipient();
    const url = await mailLink(id);
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const request = new Request(url, {
      method: "POST",
      headers: { "X-Forwarded-For": `${nextClient()}, 34.120.0.1` },
      body: form,
    });
    expect((await handleRequest(request)).status).toBe(200);
    expect(await unsubscribedAt(id)).not.toBeNull();
    expect((await oneClick(url)).status).toBe(200);
  });

  it("refuses a POST without the one-click body", async () => {
    const id = await addRecipient();
    const url = await mailLink(id);
    for (const init of [
      { body: "List-Unsubscribe=No" },
      { body: "", contentType: "application/x-www-form-urlencoded" },
      { body: '{"List-Unsubscribe":"One-Click"}', contentType: "application/json" },
      { body: "List-Unsubscribe=One-Click", contentType: "text/plain" },
    ]) {
      expect((await oneClick(url, init)).status).toBe(400);
    }
    expect(await unsubscribedAt(id)).toBeNull();
  });

  it("refuses a forged, altered or transplanted token", async () => {
    const victim = await addRecipient();
    const attacker = await addRecipient();
    const own = await mailLink(attacker);
    const signature = own.slice(own.indexOf("_") + 1);
    const base = `${LIVE_HOST}/api/_caelo/mail-link/${SLUG}/leave?token=`;
    for (const url of [
      `${base}${victim}`,
      `${base}${victim}_${"A".repeat(43)}`,
      // Someone else's id under the attacker's own signature.
      `${base}${victim}_${signature}`,
      `${base}`,
      `${LIVE_HOST}/api/_caelo/mail-link/${SLUG}/leave`,
    ]) {
      expect((await oneClick(url)).status).toBe(404);
    }
    expect(await unsubscribedAt(victim)).toBeNull();
  });

  it("reaches only the declared operation", async () => {
    const id = await addRecipient();
    const url = (await mailLink(id)).replace("/leave?", "/other?");
    expect((await oneClick(url)).status).toBe(404);
  });

  it("limits per recipient, not per address: a provider's one address serves everyone", async () => {
    const provider = nextClient();
    const first = await mailLink(await addRecipient());
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await oneClick(first, { client: provider })).status);
    }
    expect(statuses).toContain(429);
    const second = await addRecipient();
    expect((await oneClick(await mailLink(second), { client: provider })).status).toBe(200);
    expect(await unsubscribedAt(second)).not.toBeNull();
  });
});

describe("the page's own route (#1432)", () => {
  function pageCall(token: string, proof?: unknown): Promise<Response> {
    return handleRequest(
      new Request(`http://localhost/api/plugin/${SLUG}/leave`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_LIVE_ORIGIN,
          "X-Forwarded-For": `${nextClient()}, 34.120.0.1`,
        },
        body: JSON.stringify({ token, ...(proof ? { _caelo_captcha: proof } : {}) }),
      }),
    );
  }

  it("refuses a token the host did not sign, whatever else the call carries", async () => {
    const id = await addRecipient();
    expect((await pageCall(`${id}_${"A".repeat(43)}`)).status).toBe(422);
    expect((await pageCall(id)).status).toBe(422);
    expect(await unsubscribedAt(id)).toBeNull();
  });

  it("still asks a browser call for its proof-of-work: only one-click replaces it", async () => {
    const id = await addRecipient();
    const url = new URL(await mailLink(id));
    const r = await pageCall(url.searchParams.get("token") as string);
    expect(r.status).toBe(403);
    expect(await unsubscribedAt(id)).toBeNull();
  });
});

describe("the signing key (#1432)", () => {
  it("flows one way: each database has its environment's own copy, read-only for its gateway", async () => {
    const admin = new SQL(ADMIN_URL as string);
    const live = new SQL(PUBLIC_URL as string);
    const staging = new SQL(STAGING_URL as string);
    try {
      const held = await admin.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return (
          (await tx`SELECT mail_link_key, mail_link_staging_key FROM site_settings WHERE id = 1`) as {
            mail_link_key: string;
            mail_link_staging_key: string;
          }[]
        )[0];
      });
      const keyOf = async (db: SQL) =>
        (
          (await db`SELECT mail_link_key FROM published_gateway_settings`) as {
            mail_link_key: string;
          }[]
        )[0]?.mail_link_key;
      expect(held?.mail_link_key).toMatch(/^[0-9a-f]{64}$/);
      expect(held?.mail_link_staging_key).toMatch(/^[0-9a-f]{64}$/);
      expect(held?.mail_link_key).not.toBe(held?.mail_link_staging_key as string);
      expect(await keyOf(live)).toBe(held?.mail_link_key as string);
      expect(await keyOf(staging)).toBe(held?.mail_link_staging_key as string);
      for (const db of [live, staging]) {
        await expect(db`UPDATE published_gateway_settings SET mail_link_key = 'x'`).rejects.toThrow(
          /permission denied/,
        );
      }
    } finally {
      await admin.end();
      await live.end();
      await staging.end();
    }
  });

  it("is what a sent link was signed with: a link fails once the gateway holds another key", async () => {
    const id = await addRecipient();
    const url = await mailLink(id);
    resetPluginHost();
    resetDispatchOnlyHost();
    const report = await bootstrapDispatchOnly({
      infra: {
        adapter: gatewayAdapter,
        registry: new OperationRegistry(),
        mailLinks: async () => ({ origin: null, key: "0".repeat(64) }),
      },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: fixture }],
    });
    expect(report.failed).toEqual([]);
    expect((await oneClick(url)).status).toBe(404);
    expect(await unsubscribedAt(id)).toBeNull();
    resetDispatchOnlyHost();
    await gatewayHost();
  });
});
