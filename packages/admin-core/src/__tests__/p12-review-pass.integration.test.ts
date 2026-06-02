// SPDX-License-Identifier: MPL-2.0

/**
 * P12 review-pass coverage:
 *  - email_config.get / .set ops round-trip + reject AI writes.
 *  - auth plugin's new get_auth_config + apply_auth_config ops.
 *  - forms plugin honeypot path lands as status='spam', not 'new'.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import authPlugin from "@caelo-cms/plugin-auth";
import formsPlugin from "@caelo-cms/plugin-forms";
import {
  bootstrap as bootstrapPluginHost,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM_CTX = { actorId: SYSTEM_ACTOR_ID, actorKind: "system" as const, requestId: "rev-p" };
const AI_CTX = { actorId: SYSTEM_ACTOR_ID, actorKind: "ai" as const, requestId: "rev-ai" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function wipePlugins(): Promise<void> {
  resetPluginHost();
  const adminSql = new SQL(ADMIN_URL);
  try {
    await adminSql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const s of ["forms", "auth"]) {
        // v0.2.16 — clear plugin-emitted audit rows before the actor.
        await tx`DELETE FROM audit_events WHERE actor_id IN (
          SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${s})
        )`;
        await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${s})`;
        await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${s})`;
        await tx`DELETE FROM plugins WHERE slug = ${s}`;
      }
      // Reset email_config to its seeded default so test ordering
      // doesn't depend on previous-suite state.
      await tx`UPDATE email_config SET transport='none', from_address='', config_json='{}'::jsonb WHERE id=1`;
    });
  } finally {
    await adminSql.end();
  }
  const pub = new SQL(PUBLIC_URL);
  try {
    for (const s of ["forms", "auth"]) {
      await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_${s} CASCADE`);
    }
  } finally {
    await pub.end();
  }
}

// Each Tier-2/plugin-host op spawns a Deno sandbox subprocess. Under the
// full `bun test --isolate` run (154 files in parallel) subprocess startup
// contends for CPU and the default 30s per-test budget can be exceeded even
// though these tests finish quickly in isolation. Raise the budget so the
// real-Postgres + Deno-subprocess path is not a false timeout (issue #106
// step-12 follow-up; mirrors forms-plugin.integration.test.ts).
setDefaultTimeout(120_000);

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipePlugins();
  await bootstrapPluginHost({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: formsPlugin }, { definition: authPlugin }],
  });
  // Provision schemas after rows exist.
  for (const p of [formsPlugin, authPlugin]) {
    const id = await adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT id::text AS id FROM plugins WHERE slug = ${p.slug}`,
      )) as unknown as { id: string }[];
      return rows[0]?.id;
    });
    if (!id) throw new Error(`no plugin row for ${p.slug}`);
    const emitted = schemaFromSpec({ pluginId: id, slug: p.slug, schema: p.schema });
    await adapter.provisionPluginPublicSchema({ pluginId: id, sql: emitted.sql });
  }
});

afterAll(async () => {
  await wipePlugins();
  await adapter.close();
});

describe("email_config ops", () => {
  it("returns the seeded `none` row by default", async () => {
    const r = await execute(registry, adapter, SYSTEM_CTX, "email_config.get", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { config: { transport: string; fromAddress: string } };
    expect(v.config.transport).toBe("none");
    expect(v.config.fromAddress).toBe("");
  });

  it("rejects AI writes (Owner-only)", async () => {
    const r = await execute(registry, adapter, AI_CTX, "email_config.set", {
      transport: "resend",
      fromAddress: "hello@example.com",
      config: { apiKey: "re_test1234567890" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ActorScopeRejected");
  });

  it("system writes succeed and round-trip", async () => {
    const set = await execute(registry, adapter, SYSTEM_CTX, "email_config.set", {
      transport: "resend",
      fromAddress: "hello@example.com",
      config: { apiKey: "re_test1234567890" },
    });
    expect(set.ok).toBe(true);
    const get = await execute(registry, adapter, SYSTEM_CTX, "email_config.get", {});
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const v = get.value as {
      config: { transport: string; fromAddress: string; config: { apiKey: string } };
    };
    expect(v.config.transport).toBe("resend");
    expect(v.config.fromAddress).toBe("hello@example.com");
    expect(v.config.config.apiKey).toBe("re_test1234567890");
  });

  it("rejects resend without apiKey", async () => {
    const r = await execute(registry, adapter, SYSTEM_CTX, "email_config.set", {
      transport: "resend",
      fromAddress: "hello@example.com",
      config: {},
    });
    expect(r.ok).toBe(false);
  });
});

describe("auth plugin: get_auth_config + apply_auth_config", () => {
  it("get_auth_config returns defaults on a fresh install", async () => {
    const r = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "get_auth_config",
      args: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { id: string | null; signupOpen: boolean; passwordMinLength: number };
    expect(v.id).toBeNull();
    expect(v.signupOpen).toBe(true);
    expect(v.passwordMinLength).toBe(8);
  });

  it("apply_auth_config persists and is readable via get_auth_config", async () => {
    const apply = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "apply_auth_config",
      args: { signupOpen: false, passwordMinLength: 12 },
    });
    expect(apply.ok).toBe(true);
    const get = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "get_auth_config",
      args: {},
    });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const v = get.value as { signupOpen: boolean; passwordMinLength: number };
    expect(v.signupOpen).toBe(false);
    expect(v.passwordMinLength).toBe(12);
  });

  it("rejects passwords shorter than 8", async () => {
    const r = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "apply_auth_config",
      args: { signupOpen: true, passwordMinLength: 4 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("auth plugin: propose/execute split (§11.A)", () => {
  it("propose_auth_config queues a row + does NOT mutate auth_config", async () => {
    // Snapshot current config.
    const before = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "get_auth_config",
      args: {},
    });
    if (!before.ok) throw new Error("get_auth_config pre-propose failed");
    const beforeMin = (before.value as { passwordMinLength: number }).passwordMinLength;

    // Propose a change.
    const proposal = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "propose_auth_config",
      args: { signupOpen: false, passwordMinLength: 16 },
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const v = proposal.value as { proposalId: string; status: string };
    expect(v.status).toBe("pending");

    // Live config NOT yet changed.
    const after = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "get_auth_config",
      args: {},
    });
    if (!after.ok) return;
    expect((after.value as { passwordMinLength: number }).passwordMinLength).toBe(beforeMin);

    // Listing surfaces the pending row.
    const list = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "list_pending_proposals",
      args: {},
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const proposals = (list.value as { proposals: { id: string; status: string }[] }).proposals;
    expect(proposals.find((p) => p.id === v.proposalId)?.status).toBe("pending");

    // execute_proposal applies it; live config now reflects the proposed values.
    const exec = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "execute_proposal",
      args: { proposalId: v.proposalId },
    });
    expect(exec.ok).toBe(true);
    const final = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "get_auth_config",
      args: {},
    });
    if (!final.ok) return;
    expect((final.value as { passwordMinLength: number }).passwordMinLength).toBe(16);
    expect((final.value as { signupOpen: boolean }).signupOpen).toBe(false);

    // Same proposal cannot be executed twice.
    const re = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "execute_proposal",
      args: { proposalId: v.proposalId },
    });
    expect(re.ok).toBe(false);
  });

  it("reject_proposal stamps reason + status='rejected'; live config unchanged", async () => {
    const before = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "get_auth_config",
      args: {},
    });
    if (!before.ok) return;
    const beforeMin = (before.value as { passwordMinLength: number }).passwordMinLength;

    const proposal = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "propose_auth_config",
      args: { signupOpen: true, passwordMinLength: 99 },
    });
    if (!proposal.ok) return;
    const v = proposal.value as { proposalId: string };

    const reject = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "reject_proposal",
      args: { proposalId: v.proposalId, reason: "too aggressive" },
    });
    expect(reject.ok).toBe(true);

    const after = await runPluginOperation({
      pluginSlug: "auth",
      operationName: "get_auth_config",
      args: {},
    });
    if (!after.ok) return;
    expect((after.value as { passwordMinLength: number }).passwordMinLength).toBe(beforeMin);
  });
});

describe("forms plugin: honeypot lands as spam", () => {
  it("non-empty honeypot field marks the submission as spam", async () => {
    // First, create a form so submit() finds a target.
    const c = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "create_form",
      args: { slug: "contact", displayName: "Contact us", schemaJson: {}, locale: "en" },
    });
    expect(c.ok).toBe(true);
    const submit = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "submit",
      args: {
        formSlug: "contact",
        locale: "en",
        data: { email: "a@b.c" },
        honeypot: "bot-fill",
        captchaToken: "dev",
      },
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const v = submit.value as { honeypot?: boolean };
    expect(v.honeypot).toBe(true);
    // The status should be 'spam', not 'new'. List filtered by status='spam'
    // should include the row.
    const list = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: { status: "spam" },
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const rows = (list.value as { submissions: Array<{ status: string }> }).submissions;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.status).toBe("spam");
  });

  it("empty honeypot lands as new", async () => {
    const submit = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "submit",
      args: {
        formSlug: "contact",
        locale: "en",
        data: { email: "real@user.com" },
        honeypot: "",
        captchaToken: "dev",
      },
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const v = submit.value as { honeypot?: boolean };
    expect(v.honeypot).toBeUndefined();
  });
});
