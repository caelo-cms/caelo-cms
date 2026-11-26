// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — `ai_provider` and `email` for runtime-installed plugins, end to
 * end on a real Postgres and the real Deno sandbox: staged, approved by an
 * Owner, activated, then run (docs/dev/external-plugin-brokers.md §7.2,
 * §7.3).
 *
 * AI (decision Q8 A): every call is reserved in the spend ledger under the
 * plugin's own id before it reaches the provider, against the lower of the
 * daily cap approved with the running version and the Owner's own cap; a
 * plugin without an AI grant carrying a cap cannot spend at all, parallel
 * reservations cannot overshoot, and a render cannot spend.
 *
 * Email (decision Q5 A): the plugin queues its reviewed templates (worker,
 * Owner panel, its declared double opt-in) and the drain delivers them
 * within the per-recipient cap; it cannot queue another plugin's template,
 * mail from a chat, use a link token minted for another plugin, or reach a
 * free-form `send`. An installation that needs mail is not approved while
 * the site has no working transport.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  type LoadedPlugin,
  loadedPlugins,
  resetPluginHost,
  runPluginOperation,
  verifyMailUnsubscribeToken,
} from "@caelo-cms/plugin-host";
import { manifestFromDefinition, type PluginInvocation } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import newsletter from "../../../plugins/newsletter/src/index.js";
import { invalidateAllPricing } from "../ai/pricing-cache.js";
import { drainOutboxOnce } from "../email/outbox.js";
import { lockPluginRow } from "../locks.js";
import { stagingPublicAdapter } from "../public-projection.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !STAGING_ADMIN_URL) {
  throw new Error("DB URLs required (ADMIN, PUBLIC_ADMIN, PUBLIC_STAGING_ADMIN)");
}

const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "t1729-ai-email",
};
const PROVIDER = "t1729-provider";
const MODEL = "t1729-model";
const LIVE = "https://www.t1729.test";
const SCHEMAS = ["ext-ai", "ext-ai-b", "ext-ai-none", "ext-mail", "ext-mail-gate"].map(
  (slug) => `plugin_${slug.replaceAll("-", "_")}`,
);

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
const sent: Array<{ to: string; subject: string }> = [];
const realFetch = globalThis.fetch;
let providerCalls = 0;

/** Test-only reads and cleanup on their own connection, as the other spend suites do. */
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

async function call(
  name: string,
  input: unknown,
  ctx = system as { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string },
) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function owner() {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" as const };
}

/** Stage one external artifact and return what its approval needs. */
async function stage(
  m: Record<string, unknown> & { requestedCapabilities: string[] },
  src: string,
) {
  const staged = (await call("plugins.stage_installation", { manifest: m, source: src })) as {
    installationId: string;
    pluginId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  if (!item) throw new Error("review missing");
  return {
    ...staged,
    decision: {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item.currentStateDigest,
      capabilities: m.requestedCapabilities,
    },
  };
}

/** Stage, approve as an Owner and activate one external artifact. */
async function install(
  m: Record<string, unknown> & { requestedCapabilities: string[] },
  src: string,
) {
  const staged = await stage(m, src);
  await call("plugins.approve_installation", staged.decision, await owner());
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
  return { pluginId: staged.pluginId, installationId: staged.installationId };
}

function aiPlugin(slug: string, capMicrocents: number) {
  return {
    manifest: {
      slug,
      version: "1.0.0",
      tier: 2,
      schema: {},
      operations: ["ask", "shape"],
      requestedCapabilities: ["ai_provider"],
      capabilityReasons: { ai_provider: "Summarise the operator's notes" },
      capabilityConstraints: { ai_provider: { maxDailyCostMicrocents: capMicrocents } },
    },
    source: `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
      ask: async (ctx) => (await ctx.ai.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 1000 })).text,
      shape: async (ctx) => (await ctx.ai.generateObject({ system: "s", messages: [], jsonSchema: { type: "object" }, maxTokens: 100 })).object,
    }};`,
  };
}

/** What the plugin's ledger rows say: who paid, as whom, and how much. */
async function spendOf(pluginId: string) {
  return onDb(
    ADMIN_URL as string,
    (tx) =>
      tx`SELECT actor_id::text AS actor_id, reservation, cost_estimate_microcents::int AS cost
         FROM ai_calls WHERE plugin_id = ${pluginId}::uuid ORDER BY created_at`,
  ) as Promise<{ actor_id: string; reservation: string; cost: number }[]>;
}

const run = (slug: string, operationName: string, invocation: PluginInvocation, args = {}) =>
  runPluginOperation({ pluginSlug: slug, operationName, args, invocation });

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  registerAdminOps(registry);
  await adapter.withAdminTransaction(system, async (tx) => {
    for (const schema of SCHEMAS)
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    // Input 2,000 µ¢ per 1K tokens, output 5,000 per 1K.
    await tx.execute(sql`
      INSERT INTO ai_pricing (provider, model, operation_type, input_microcents, output_microcents,
                              cached_microcents, cache_creation_microcents)
      VALUES (${PROVIDER}, ${MODEL}, 'text', 2000, 5000, 200, 5000)
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(
      sql`UPDATE ai_budgets SET cap_microcents = NULL WHERE operation_type = 'text'`,
    );
  });
  invalidateAllPricing();
  await bootstrap({
    infra: {
      adapter,
      registry,
      lockPluginRow,
      stagingAdapter: stagingPublicAdapter(STAGING_ADMIN_URL as string),
      mailLinks: async () => ({ origin: LIVE, key: "ab".repeat(32) }),
      aiProvider: {
        resolve: async () => ({ provider: PROVIDER, model: MODEL }),
        complete: async () => {
          providerCalls += 1;
          // 1,000 in + 1,000 out = 7,000 µ¢ settled per call.
          return {
            text: "summary",
            inputTokens: 1000,
            outputTokens: 1000,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            provider: PROVIDER,
            model: MODEL,
          };
        },
        generateObject: async () => {
          providerCalls += 1;
          return {
            object: { ok: true },
            inputTokens: 10,
            outputTokens: 10,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            provider: PROVIDER,
            model: MODEL,
          };
        },
      } as never,
    },
    pluginsRoot: "/dev/null/unused",
    systemActorId: system.actorId,
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
    sent.push({ to: body.to[0] ?? "", subject: body.subject });
    return new Response(JSON.stringify({ id: `msg-${sent.length}` }), { status: 200 });
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  resetPluginHost();
  await adapter.withAdminTransaction(system, async (tx) => {
    for (const schema of SCHEMAS)
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await tx.execute(
      sql`UPDATE email_config SET transport = 'none', config_json = '{}' WHERE id = 1`,
    );
  });
  await onDb(PUBLIC_ADMIN_URL as string, (tx) => tx`DELETE FROM mail_outbox`);
  await adapter.close();
});

describe("#1729 ai_provider — an installed plugin spends under the cap approved with it (Q8 A)", () => {
  let a: { pluginId: string; installationId: string };
  let b: { pluginId: string; installationId: string };

  beforeAll(async () => {
    // One call reserves its worst case (about 15,000 µ¢) and settles at 7,000.
    a = await install(aiPlugin("ext-ai", 20_000).manifest, aiPlugin("ext-ai", 20_000).source);
    b = await install(
      aiPlugin("ext-ai-b", 1_000_000_000).manifest,
      aiPlugin("ext-ai-b", 1_000_000_000).source,
    );
  });

  it("a call is reserved and settled under the plugin's own id, for the person it acts for", async () => {
    const person = await owner();
    const r = await run("ext-ai", "ask", { origin: "owner-panel", actorId: person.actorId });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value).toBe("summary");
    expect(await spendOf(a.pluginId)).toEqual([
      { actor_id: person.actorId, reservation: "settled", cost: 7_000 },
    ]);
    // A worker run acts for nobody: the system actor, still this plugin's spend.
    const w = await run("ext-ai", "shape", { origin: "worker", actorId: system.actorId });
    if (!w.ok) throw new Error(JSON.stringify(w.error));
    expect(w.value).toEqual({ ok: true });
    expect((await spendOf(a.pluginId)).map((row) => row.actor_id)).toEqual([
      person.actorId,
      system.actorId,
    ]);
    // Nothing was booked on the other plugin.
    expect(await spendOf(b.pluginId)).toEqual([]);
  });

  it("past the approved daily cap the next call is refused before the provider (adversarial)", async () => {
    const before = providerCalls;
    let refusal = "";
    for (let i = 0; i < 5 && !refusal; i++) {
      const r = await run("ext-ai", "ask", { origin: "worker", actorId: system.actorId });
      if (!r.ok) refusal = JSON.stringify(r.error);
    }
    expect(refusal).toContain(
      "AiBudgetReached (plugin): the daily AI cap approved with this plugin version",
    );
    // Every admitted call fit under the cap at its worst case; the refused one never ran.
    const total = (await spendOf(a.pluginId)).reduce((sum, row) => sum + row.cost, 0);
    expect(total).toBeLessThanOrEqual(20_000);
    expect(providerCalls - before).toBe((await spendOf(a.pluginId)).length - 2);
    // The other plugin's spend is its own: it still runs.
    const other = await run("ext-ai-b", "ask", { origin: "worker", actorId: system.actorId });
    expect(other.ok).toBe(true);
  });

  it("the Owner's lower cap binds, and the plugin reports both", async () => {
    await adapter.withAdminTransaction(system, (tx) =>
      tx.execute(
        sql`UPDATE plugins SET ai_cost_cap_microcents = 100 WHERE id = ${b.pluginId}::uuid`,
      ),
    );
    const r = await run("ext-ai-b", "ask", { origin: "worker", actorId: system.actorId });
    expect(r.ok ? "" : JSON.stringify(r.error)).toContain("the plugin's own AI cap is reached");
    const spend = (await call("ai_calls.aggregate_per_plugin", { pluginId: b.pluginId })) as {
      capMicrocents: number | null;
      ownerCapMicrocents: number | null;
      approvedCapMicrocents: number | null;
    };
    expect(spend).toMatchObject({
      capMicrocents: 100,
      ownerCapMicrocents: 100,
      approvedCapMicrocents: 1_000_000_000,
    });
    await adapter.withAdminTransaction(system, (tx) =>
      tx.execute(
        sql`UPDATE plugins SET ai_cost_cap_microcents = NULL WHERE id = ${b.pluginId}::uuid`,
      ),
    );
  });

  it("parallel reservations cannot overshoot the approved cap (adversarial)", async () => {
    const reserve = () =>
      execute(registry, adapter, system, "ai_ledger.reserve", {
        spender: {
          kind: "plugin",
          pluginId: b.pluginId,
          actorId: system.actorId,
          chatSessionId: null,
        },
        provider: PROVIDER,
        model: MODEL,
        // 1,000 prompt tokens at the dearest input lane (5,000/1K) + 1,000
        // output at 5,000/1K = 10,000 µ¢ worst case each.
        request: { promptTokens: 1_000, maxOutputTokens: 1_000 },
        what: "a parallel probe",
      });
    const spentBefore = (await spendOf(b.pluginId)).reduce((sum, row) => sum + row.cost, 0);
    // Room for five more at the worst case under a cap of spent + 50,000.
    await onDb(ADMIN_URL as string, async (tx) => {
      // The receipt is immutable: lower the bound through the Owner's cap.
      await tx`UPDATE plugins SET ai_cost_cap_microcents = ${spentBefore + 50_000} WHERE id = ${b.pluginId}::uuid`;
    });
    const results = await Promise.all(Array.from({ length: 20 }, reserve));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(15);
    await onDb(ADMIN_URL as string, async (tx) => {
      await tx`UPDATE plugins SET ai_cost_cap_microcents = NULL WHERE id = ${b.pluginId}::uuid`;
    });
  });

  it("a render cannot spend the site's AI (adversarial)", async () => {
    const r = await run("ext-ai-b", "ask", { origin: "render", actorId: system.actorId });
    expect(r.ok ? "" : JSON.stringify(r.error)).toContain("cannot call the AI from a render call");
  });

  it("a plugin without an AI grant carrying a cap cannot spend, even through the ledger (adversarial)", async () => {
    // A runtime-installed plugin whose receipts hold no ai_provider: the
    // ledger refuses its text spend outright, whoever asks for it.
    const none = await install(
      {
        slug: "ext-ai-none",
        version: "1.0.0",
        tier: 2,
        schema: {},
        adminSchema: { notes: { body: "text" } },
        operations: ["noop"],
        requestedCapabilities: ["cms_admin_schema"],
        capabilityReasons: { cms_admin_schema: "Keep notes" },
      },
      `export default {slug:"ext-ai-none",version:"1.0.0",tier:2,operations:{noop:async()=>null}};`,
    );
    const r = await execute(registry, adapter, system, "ai_ledger.reserve", {
      spender: {
        kind: "plugin",
        pluginId: none.pluginId,
        actorId: system.actorId,
        chatSessionId: null,
      },
      provider: PROVIDER,
      model: MODEL,
      request: { promptTokens: 10, maxOutputTokens: 10 },
      what: "a probe",
    });
    expect(r.ok ? "" : r.error.kind === "HandlerError" ? r.error.message : "").toContain(
      "has no daily AI cap",
    );
    // An ai_provider receipt without a cap (written past the staging check,
    // or before it existed) grants no spend either.
    await onDb(ADMIN_URL as string, async (tx) => {
      await tx`INSERT INTO plugin_capability_grants (plugin_id, artifact_digest, capability, constraints, approved_by)
               SELECT plugin_id, artifact_digest, 'ai_provider', '{}'::jsonb, ${system.actorId}::uuid
               FROM plugin_installation_versions WHERE id = ${none.installationId}::uuid`;
    });
    const uncapped = await execute(registry, adapter, system, "ai_ledger.reserve", {
      spender: {
        kind: "plugin",
        pluginId: none.pluginId,
        actorId: system.actorId,
        chatSessionId: null,
      },
      provider: PROVIDER,
      model: MODEL,
      request: { promptTokens: 10, maxOutputTokens: 10 },
      what: "a probe",
    });
    expect(
      uncapped.ok ? "" : uncapped.error.kind === "HandlerError" ? uncapped.error.message : "",
    ).toContain("has no daily AI cap");
    // Revoking the grant disables the plugin; the ledger then refuses it too.
    await call(
      "plugins.revoke_capability",
      { installationId: a.installationId, capability: "ai_provider" },
      await owner(),
    );
    const after = await execute(registry, adapter, system, "ai_ledger.reserve", {
      spender: {
        kind: "plugin",
        pluginId: a.pluginId,
        actorId: system.actorId,
        chatSessionId: null,
      },
      provider: PROVIDER,
      model: MODEL,
      request: { promptTokens: 10, maxOutputTokens: 10 },
      what: "a probe",
    });
    expect(
      after.ok ? "" : after.error.kind === "HandlerError" ? after.error.message : "",
    ).toContain("has no daily AI cap");
  });
});

describe("#1729 email — an installed plugin queues its reviewed templates (Q5 A)", () => {
  const base = manifestFromDefinition(newsletter);
  /** The newsletter's double opt-in, as an installed plugin declares it. */
  const mailManifest = (slug: string) => ({
    slug,
    version: "1.0.0",
    tier: 2,
    schema: { subscribers: base.schema.subscribers },
    tableKinds: { subscribers: "visitor-state" },
    indexes: { schema: { subscribers: base.indexes?.schema?.subscribers } },
    requires: ["email"],
    requestedCapabilities: ["email"],
    capabilityReasons: { email: "Confirm sign-ups and send a note" },
    mailTemplates: {
      confirm_it: {
        subject: "Confirm your sign-up",
        body: ["Please confirm."],
        link: { operation: "confirm", label: "Confirm", done: "Confirmed." },
      },
      note: { subject: "A note", body: ["Just a note."] },
    },
    mailUnsubscribe: { operation: "leave", label: "Leave", done: "You left." },
    publicOperations: (base.publicOperations ?? [])
      .filter((op) => ["subscribe", "confirm", "unsubscribe"].includes(op.name))
      .map((op) =>
        op.name === "subscribe"
          ? {
              ...op,
              // An installed plugin's schemas keep to the safe subset (no `pattern`).
              inputJsonSchema: {
                type: "object",
                additionalProperties: false,
                required: ["email"],
                properties: {
                  email: { type: "string", maxLength: 254, format: "email" },
                  hp_address: { type: "string", maxLength: 500 },
                },
              },
              run: {
                action: "block",
                block: "double-opt-in.subscribe",
                options: { table: "subscribers", template: "confirm_it", hours: 48 },
              },
            }
          : op.name === "unsubscribe"
            ? { ...op, name: "leave" }
            : op,
      ),
    operations: ["notify", "flood", "foreign", "link"],
  });
  const mailSource = (
    slug: string,
  ) => `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
    notify: async (ctx, args) => { await ctx.email.queue({ template: "note", to: args.to }); return typeof ctx.email.send; },
    flood: async (ctx, args) => { for (let i = 0; i < 30; i++) await ctx.email.queue({ template: "note", to: args.to }); return 30; },
    foreign: async (ctx) => { await ctx.email.queue({ template: "confirm_subscription", to: "x@example.test" }); },
    link: async (ctx, args) => ctx.email.unsubscribeLink({ recipientId: args.recipientId }),
  }};`;
  const drain = () =>
    drainOutboxOnce({ registry, adapter, publicAdapter: adapter, environment: "live" });

  it("is not approved while the site has no working mail transport", async () => {
    await adapter.withAdminTransaction(system, (tx) =>
      tx.execute(sql`UPDATE email_config SET transport = 'none', config_json = '{}' WHERE id = 1`),
    );
    const staged = await stage(mailManifest("ext-mail-gate"), mailSource("ext-mail-gate"));
    const r = await execute(
      registry,
      adapter,
      await owner(),
      "plugins.approve_installation",
      staged.decision,
    );
    expect(r.ok ? "" : JSON.stringify(r.error)).toContain("the mail transport cannot deliver");
    // No receipt was written for it.
    const grants = await onDb(
      ADMIN_URL as string,
      (tx) => tx`SELECT 1 FROM plugin_capability_grants WHERE plugin_id = ${staged.pluginId}::uuid`,
    );
    expect(grants).toHaveLength(0);
  });

  it("queues a template from a worker; the drain delivers it, within the per-recipient cap", async () => {
    await adapter.withAdminTransaction(system, async (tx) => {
      await tx.execute(sql`UPDATE site_defaults SET site_base_url = ${LIVE} WHERE id = 1`);
      await tx.execute(sql`UPDATE email_config SET transport = 'resend', from_address = 'noreply@t1729.test',
               config_json = '{"apiKey":"re_test_key"}' WHERE id = 1`);
      await tx.execute(sql`DELETE FROM public_mail_deliveries`);
    });
    await onDb(PUBLIC_ADMIN_URL as string, (tx) => tx`DELETE FROM mail_outbox`);
    const { pluginId } = await install(mailManifest("ext-mail"), mailSource("ext-mail"));
    const worker = { origin: "worker" as const, actorId: system.actorId };
    const r = await run("ext-mail", "notify", worker, { to: "Reader@Example.test" });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    // There is no free-form send in the sandbox.
    expect(r.value).toBe("undefined");
    const rows = await onDb(
      PUBLIC_ADMIN_URL as string,
      (tx) => tx`SELECT plugin_id::text AS plugin_id, template, recipient FROM mail_outbox`,
    );
    expect(rows).toEqual([
      { plugin_id: pluginId, template: "note", recipient: "reader@example.test" },
    ]);
    sent.length = 0;
    expect((await drain()).sent).toBe(1);
    expect(sent).toEqual([{ to: "reader@example.test", subject: "A note" }]);
    // A flood to one address gets no more than the per-recipient cap (5 a day, 0611).
    const flood = await run("ext-mail", "flood", worker, { to: "victim@example.test" });
    expect(flood.ok).toBe(true);
    sent.length = 0;
    await drain();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(5);
  });

  it("refuses another plugin's template and a chat call (adversarial)", async () => {
    const foreign = await run("ext-mail", "foreign", { origin: "worker", actorId: system.actorId });
    expect(foreign.ok ? "" : JSON.stringify(foreign.error)).toContain(
      'declares no mail template \\"confirm_subscription\\"',
    );
    const person = await owner();
    const session = (await call(
      "chat.create_session",
      { isolation: "experiment", title: "t1729 mail from a chat" },
      person,
    )) as { chatSessionId: string; chatBranchId: string };
    const chat = await run(
      "ext-mail",
      "notify",
      {
        origin: "chat",
        actorId: system.actorId,
        operatorActorId: person.actorId,
        chatBranchId: session.chatBranchId,
        chatTaskId: session.chatSessionId,
      },
      { to: "a@example.test" },
    );
    expect(chat.ok ? "" : JSON.stringify(chat.error)).toContain("cannot mail from a chat call");
  });

  it("an unsubscribe link is signed for this plugin only (adversarial)", async () => {
    const recipientId = crypto.randomUUID();
    const r = await run(
      "ext-mail",
      "link",
      { origin: "worker", actorId: system.actorId },
      { recipientId },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const url = new URL(String(r.value));
    expect(`${url.origin}${url.pathname}`).toBe(`${LIVE}/api/_caelo/mail-link/ext-mail/leave`);
    const token = url.searchParams.get("token");
    const infra = {
      adapter,
      registry,
      mailLinks: async () => ({ origin: LIVE, key: "ab".repeat(32) }),
    };
    const own = loadedPlugins.bySlug("ext-mail") as LoadedPlugin;
    expect(await verifyMailUnsubscribeToken(own, infra, token)).toBe(true);
    // The same token says nothing about another plugin's list.
    const other = { ...own, slug: "newsletter", definition: newsletter } as unknown as LoadedPlugin;
    expect(await verifyMailUnsubscribeToken(other, infra, token)).toBe(false);
  });

  it("a visitor's double opt-in queues the plugin's confirmation template", async () => {
    await onDb(PUBLIC_ADMIN_URL as string, (tx) => tx`DELETE FROM mail_outbox`);
    const r = await run(
      "ext-mail",
      "subscribe",
      { origin: "system", actorId: system.actorId },
      { email: "fan@example.test" },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value).toEqual({ awaitingConfirm: true });
    const rows = await onDb(
      PUBLIC_ADMIN_URL as string,
      (tx) => tx`SELECT template, recipient FROM mail_outbox`,
    );
    expect(rows).toEqual([{ template: "confirm_it", recipient: "fan@example.test" }]);
  });
});
