// SPDX-License-Identifier: MPL-2.0

/**
 * #1337 (epic #763 M7) — the public mail outboxes, drained by the admin.
 *
 * - The visitor roles may only queue: INSERT of the payload columns, for an
 *   active published plugin, with shape-checked values. No read back, no
 *   delete, no update.
 * - A forged outbox cannot choose the mail's text, the link's host or more
 *   recipients than the caps: subject, text and link come from the plugin's
 *   template, the host from cms_admin, the counts from a cms_admin ledger.
 * - The staging outbox mails only addresses of cms_admin users (#1330 → here).
 * - The transport cannot be switched off while a plugin that needs it runs.
 *
 * The transport is Resend with `fetch` stubbed: nothing leaves the machine.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost, runPluginOperation } from "@caelo-cms/plugin-host";
import { definePlugin, type PluginContextTier1, z } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { drainOutboxOnce, MAIL_OUTBOX_TTL_MINUTES } from "../email/outbox.js";
import { MAIL_RECIPIENT_CAP, MAIL_SITE_CAP_PER_HOUR } from "../ops/mail_outbox.js";
import { releaseProjectionForTests, stagingPublicAdapter } from "../public-projection.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_ROLE_URL = process.env.PUBLIC_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
const STAGING_ROLE_URL = process.env.PUBLIC_STAGING_DATABASE_URL;
if (
  !ADMIN_URL ||
  !PUBLIC_ADMIN_URL ||
  !PUBLIC_ROLE_URL ||
  !STAGING_ADMIN_URL ||
  !STAGING_ROLE_URL
) {
  throw new Error(
    "DB URLs required (ADMIN, PUBLIC_ADMIN, PUBLIC, PUBLIC_STAGING_ADMIN, PUBLIC_STAGING)",
  );
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "human",
  requestId: "t1337",
};
const SLUG = "t1337-mailer";
const TOKEN = "tok_0123456789abcdef";
const TEAM = "team-member@t1337.test";
const TEAM_ID = "13370000-0000-4000-8000-000000000001";

const mailer = definePlugin<PluginContextTier1>({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: {},
  requires: ["email"],
  requestedCapabilities: ["email"],
  mailTemplates: {
    confirm_it: {
      subject: "Confirm it",
      body: ["Please confirm."],
      link: { operation: "confirm", label: "Confirm", done: "Done." },
    },
    plain_note: { subject: "A note", body: ["Just a note."] },
  },
  publicOperations: [
    {
      name: "confirm",
      kind: "write",
      input: z.object({ token: z.string().min(16).max(128) }).strict(),
    },
  ],
  operations: {
    confirm: async () => ({ confirmed: true }),
    // An admin-side caller (an Owner panel action) queueing a mail.
    queue_it: async (ctx, args) => {
      const { to } = args as { to: string };
      await ctx.email?.queue({ template: "confirm_it", to, token: TOKEN });
      return { queued: true };
    },
  },
});

const domainCalls: string[] = [];

/** Resend's domains API as documented (https://resend.com/docs/api-reference/domains). */
function resendDomains(url: string, init?: RequestInit): Response {
  domainCalls.push(`${init?.method ?? "GET"} ${url.replace("https://api.resend.com", "")}`);
  if (url.endsWith("/domains?limit=100")) {
    return Response.json({
      object: "list",
      has_more: false,
      data: [
        {
          id: "dom-1",
          name: "t1337.test",
          status: "pending",
          created_at: "2026-11-01",
          region: "eu-west-1",
        },
      ],
    });
  }
  if (url.endsWith("/domains/dom-1/verify"))
    return Response.json({ object: "domain", id: "dom-1" });
  return Response.json({
    object: "domain",
    id: "dom-1",
    name: "t1337.test",
    status: "pending",
    records: [
      {
        record: "SPF",
        name: "send",
        type: "MX",
        ttl: "Auto",
        status: "verified",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
      },
      {
        record: "DKIM",
        name: "resend._domainkey",
        type: "TXT",
        ttl: "Auto",
        status: "pending",
        value: "p=MIGf",
      },
    ],
  });
}

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let registry: OperationRegistry;
let pluginId = "";
const sent: Array<{ to: string; subject: string; html: string }> = [];
const realFetch = globalThis.fetch;

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>, system = true): Promise<T> {
  const sql = new SQL(url);
  try {
    return (await sql.begin(async (tx) => {
      if (system) await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  await onDb(ADMIN_URL as string, async (tx) => {
    await tx`DELETE FROM public_mail_deliveries`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
    await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    await tx`DELETE FROM users WHERE id = ${TEAM_ID}::uuid`;
    await tx`DELETE FROM actors WHERE id = ${TEAM_ID}::uuid`;
    await tx`UPDATE email_config SET transport = 'none', config_json = '{}' WHERE id = 1`;
  });
  for (const url of [PUBLIC_ADMIN_URL, STAGING_ADMIN_URL] as string[]) {
    await onDb(url, (tx) => tx`DELETE FROM mail_outbox`);
  }
}

/** Queue rows the way a (possibly compromised) gateway can: as its visitor role. */
async function queueAsVisitor(
  url: string,
  rows: Array<{ template: string; recipient: string; token: string | null; plugin?: string }>,
): Promise<void> {
  const sql = new SQL(url);
  try {
    for (const r of rows) {
      await sql`INSERT INTO mail_outbox (plugin_id, template, recipient, token)
                VALUES (${r.plugin ?? pluginId}::uuid, ${r.template}, ${r.recipient}, ${r.token})`;
    }
  } finally {
    await sql.end();
  }
}

function drain(environment: "live" | "staging") {
  return drainOutboxOnce({
    registry,
    adapter,
    publicAdapter: environment === "live" ? adapter : staging,
    environment,
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  staging = stagingPublicAdapter(STAGING_ADMIN_URL as string);
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await onDb(ADMIN_URL as string, async (tx) => {
    await tx`UPDATE site_defaults SET site_base_url = 'https://www.t1337.test' WHERE id = 1`;
    await tx`UPDATE staging_access SET staging_host = 'staging.t1337.test' WHERE id = 1`;
    await tx`UPDATE email_config SET transport = 'resend', from_address = 'noreply@t1337.test',
               config_json = '{"apiKey":"re_test_key"}' WHERE id = 1`;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${TEAM_ID}::uuid, 'human', 'T1337 team')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${TEAM_ID}::uuid, 'Team-Member@t1337.test', 'test-only')`;
  });
  const boot = await bootstrap({
    infra: { adapter, registry, stagingAdapter: staging },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: mailer }],
  });
  expect(boot.failed).toEqual([]);
  pluginId = (
    await onDb(
      ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as { id: string }[],
    )
  )[0]?.id as string;
  // The outbox policy admits only plugins the admin published as active.
  await releaseProjectionForTests(adapter, staging);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com/domains")) return resendDomains(url, init);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; html: string };
    sent.push({ to: body.to[0] ?? "", subject: body.subject, html: body.html });
    return new Response(JSON.stringify({ id: `msg-${sent.length}` }), { status: 200 });
  }) as typeof fetch;
});

beforeEach(async () => {
  sent.length = 0;
  await onDb(ADMIN_URL as string, (tx) => tx`DELETE FROM public_mail_deliveries`);
  for (const url of [PUBLIC_ADMIN_URL, STAGING_ADMIN_URL] as string[]) {
    await onDb(url, (tx) => tx`DELETE FROM mail_outbox`);
  }
});

afterEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await wipe();
  await adapter.close();
  await staging.close();
});

describe("the visitor role may only queue (#1337)", () => {
  for (const [label, url] of [
    ["live", PUBLIC_ROLE_URL],
    ["staging", STAGING_ROLE_URL],
  ] as const) {
    it(`${label}: inserts, but never reads, changes or deletes the queue`, async () => {
      await queueAsVisitor(url as string, [
        { template: "plain_note", recipient: "a@x.test", token: null },
      ]);
      const sql = new SQL(url as string);
      try {
        await expect(sql`SELECT * FROM mail_outbox`).rejects.toThrow(/permission denied/);
        await expect(sql`DELETE FROM mail_outbox`).rejects.toThrow(/permission denied/);
        await expect(sql`UPDATE mail_outbox SET template = 'x'`).rejects.toThrow(
          /permission denied/,
        );
        // Not for a plugin the admin did not publish as active.
        await expect(
          sql`INSERT INTO mail_outbox (plugin_id, template, recipient) VALUES (gen_random_uuid(), 'plain_note', 'a@x.test')`,
        ).rejects.toThrow(/row-level security/);
        // Shapes are checked: no header injection, no markup in the token.
        await expect(
          sql`INSERT INTO mail_outbox (plugin_id, template, recipient) VALUES (${pluginId}::uuid, 'plain_note', ${"a@x.test\r\nBcc: b@y.test"})`,
        ).rejects.toThrow(/check constraint/);
        await expect(
          sql`INSERT INTO mail_outbox (plugin_id, template, recipient, token) VALUES (${pluginId}::uuid, 'confirm_it', 'a@x.test', ${"<a href=//evil.test>x</a>"})`,
        ).rejects.toThrow(/check constraint/);
        // `created_at` is not the writer's to choose.
        await expect(
          sql`INSERT INTO mail_outbox (plugin_id, template, recipient, created_at) VALUES (${pluginId}::uuid, 'plain_note', 'a@x.test', now() + interval '1 day')`,
        ).rejects.toThrow(/permission denied/);
      } finally {
        await sql.end();
      }
    });
  }
});

describe("the admin drains the live outbox", () => {
  it("delivers a queued template with an absolute link to the live host", async () => {
    const r = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "queue_it",
      args: { to: "Reader@Example.test " },
      invocation: { origin: "owner-panel", actorId: SYSTEM_ACTOR_ID },
    });
    expect(r.ok).toBe(true);
    const report = await drain("live");
    expect(report.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("reader@example.test");
    expect(sent[0]?.subject).toBe("Confirm it");
    expect(sent[0]?.html).toContain(
      `https://www.t1337.test/api/_caelo/mail-link/${SLUG}/confirm?token=${TOKEN}`,
    );
  });

  it("a forged row cannot choose the template, the link host or more mails than the caps", async () => {
    await queueAsVisitor(PUBLIC_ROLE_URL as string, [
      // A template the plugin does not declare: dropped.
      { template: "free_text", recipient: "a@x.test", token: TOKEN },
      // A linking template without a token: no half mail.
      { template: "confirm_it", recipient: "b@x.test", token: null },
      // Ten mails to one recipient: the per-recipient cap delivers five.
      ...Array.from({ length: 10 }, () => ({
        template: "confirm_it",
        recipient: "victim@x.test",
        token: TOKEN,
      })),
    ]);
    const report = await drain("live");
    expect(report.invalid).toBe(1);
    expect(report.refused.no_token).toBe(1);
    expect(report.refused.recipient_cap).toBe(10 - MAIL_RECIPIENT_CAP);
    expect(sent.filter((m) => m.to === "victim@x.test")).toHaveLength(MAIL_RECIPIENT_CAP);
    for (const m of sent) {
      // Text and link come from the template and cms_admin only.
      expect(m.subject).toBe("Confirm it");
      expect(m.html).toContain("https://www.t1337.test/api/_caelo/mail-link/");
      expect(m.html).not.toContain("free_text");
    }
    // A later drain still counts what was delivered: the cap holds across ticks.
    await queueAsVisitor(PUBLIC_ROLE_URL as string, [
      { template: "confirm_it", recipient: "victim@x.test", token: TOKEN },
    ]);
    expect((await drain("live")).refused.recipient_cap).toBe(1);
  });

  it("caps the whole site per hour", async () => {
    const cap = MAIL_SITE_CAP_PER_HOUR.live;
    const sql = new SQL(PUBLIC_ROLE_URL as string);
    try {
      await sql`INSERT INTO mail_outbox (plugin_id, template, recipient)
                SELECT ${pluginId}::uuid, 'plain_note', 'r' || g || '@x.test'
                FROM generate_series(1, ${cap + 5}) AS g`;
    } finally {
      await sql.end();
    }
    const first = await drain("live");
    const second = await drain("live");
    expect(first.sent + second.sent).toBe(cap);
    expect(second.refused.site_cap).toBe(5);
  });

  it("drops a row older than the outbox's lifetime unsent", async () => {
    await onDb(PUBLIC_ADMIN_URL as string, async (tx) => {
      await tx`INSERT INTO mail_outbox (plugin_id, template, recipient, created_at)
               VALUES (${pluginId}::uuid, 'plain_note', 'late@x.test',
                       now() - make_interval(mins => ${MAIL_OUTBOX_TTL_MINUTES + 1}))`;
    });
    const report = await drain("live");
    expect(report.expired).toBe(1);
    expect(sent).toHaveLength(0);
  });
});

describe("the staging outbox mails only the team (#1330 → #1337)", () => {
  it("never mails an address from the staging database that is not a cms_admin user", async () => {
    await queueAsVisitor(STAGING_ROLE_URL as string, [
      { template: "confirm_it", recipient: "reviewer@outside.test", token: TOKEN },
      { template: "confirm_it", recipient: TEAM, token: TOKEN },
    ]);
    const report = await drain("staging");
    expect(report.refused.not_a_team_member).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(TEAM);
    expect(sent[0]?.subject).toBe("[Staging] Confirm it");
    expect(sent[0]?.html).toContain(
      `https://staging.t1337.test/api/_caelo/mail-link/${SLUG}/confirm?token=${TOKEN}`,
    );
    expect(sent.some((m) => m.to === "reviewer@outside.test")).toBe(false);
  });

  it("staging mail never reaches the live outbox and live never reads staging's", async () => {
    await queueAsVisitor(STAGING_ROLE_URL as string, [
      { template: "plain_note", recipient: TEAM, token: null },
    ]);
    expect((await drain("live")).claimed).toBe(0);
    expect((await drain("staging")).sent).toBe(1);
  });
});

describe("the transport stays while a plugin needs it", () => {
  it("email_config.set refuses `none` while a plugin requiring mail is active, naming it", async () => {
    const r = await execute(registry, adapter, OWNER, "email_config.set", {
      transport: "none",
      fromAddress: "",
      config: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const message = "message" in r.error ? String(r.error.message) : "";
      expect(message).toContain(`"${SLUG}"`);
      expect(message).toContain("Settings → Plugins");
    }
  });

  it("with no transport, queued mail stays and the drain fails loudly", async () => {
    await onDb(
      ADMIN_URL as string,
      (tx) => tx`UPDATE email_config SET transport = 'none' WHERE id = 1`,
    );
    try {
      await queueAsVisitor(PUBLIC_ROLE_URL as string, [
        { template: "plain_note", recipient: "a@x.test", token: null },
      ]);
      await expect(drain("live")).rejects.toThrow(/cannot be sent.*Settings → Email/);
      expect(
        (
          await onDb(
            PUBLIC_ADMIN_URL as string,
            async (tx) => (await tx`SELECT count(*)::int AS n FROM mail_outbox`) as { n: number }[],
          )
        )[0]?.n,
      ).toBe(1);
    } finally {
      await onDb(
        ADMIN_URL as string,
        (tx) => tx`UPDATE email_config SET transport = 'resend' WHERE id = 1`,
      );
    }
  });
});

describe("the sending domain's DNS records (E12)", () => {
  it("lists what the provider needs and asks it to verify again", async () => {
    domainCalls.length = 0;
    const r = await execute(
      registry,
      adapter,
      { ...OWNER, actorKind: "ai" },
      "email_config.sender_domain",
      { verify: true },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value).toMatchObject({
      found: true,
      domain: "t1337.test",
      status: "pending",
      verificationStarted: true,
    });
    const records = (r.value as { records: Array<{ purpose: string; status: string }> }).records;
    expect(records.map((x) => `${x.purpose}:${x.status}`)).toEqual([
      "SPF:verified",
      "DKIM:pending",
    ]);
    expect(domainCalls).toEqual([
      "GET /domains?limit=100",
      "POST /domains/dom-1/verify",
      "GET /domains/dom-1",
    ]);
  });
});
