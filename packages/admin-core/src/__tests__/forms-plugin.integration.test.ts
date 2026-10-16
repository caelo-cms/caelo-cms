// SPDX-License-Identifier: MPL-2.0

/**
 * P12 PR2.2 — Forms plugin end-to-end via the API gateway.
 *
 * Validates:
 *   - Plugin loads + cms_public schema gets provisioned (forms + form_submissions).
 *   - Owner creates a form definition (admin op).
 *   - Visitor POSTs to /api/plugin/forms/submit via the gateway → submission lands.
 *     No consent provider runs here, so nobody consented to the visitor-id
 *     cookie (#677): none is set and the row's visitor_id is null — a form
 *     submission works without one.
 *   - Admin lists submissions → sees the visitor's row.
 *   - mark_read flips status; archive flips again.
 *   - submit refuses unknown form slug.
 *   - Cross-plugin RLS: a second plugin sharing schema shape can't read forms data.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "@caelo-cms/api-gateway/server";
import formsPlugin from "@caelo-cms/plugin-forms";
import {
  bootstrap as bootstrapPluginHost,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { publishProjectionOnce } from "../public-projection.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_ROLE_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !PUBLIC_ROLE_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const FORM_SLUG = "test-p12-contact";

let adapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let registry: OperationRegistry;

async function wipe(): Promise<void> {
  resetPluginHost();
  const adminSql = new SQL(ADMIN_URL);
  try {
    await adminSql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // v0.2.16 — clear plugin-emitted audit rows before the actor.
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (
          SELECT id FROM plugins WHERE slug IN ('forms', 'test-p12-other')
        )
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug IN ('forms', 'test-p12-other'))`;
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug IN ('forms', 'test-p12-other'))`;
      await tx`DELETE FROM plugins WHERE slug IN ('forms', 'test-p12-other')`;
    });
  } finally {
    await adminSql.end();
  }
  const pub = new SQL(PUBLIC_URL);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_forms CASCADE`);
    await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_test_p12_other CASCADE`);
  } finally {
    await pub.end();
  }
}

async function provisionSchemaFor(
  slug: string,
  schema: Record<string, Record<string, string>>,
): Promise<void> {
  const id = await adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "p" },
    async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT id::text AS id FROM plugins WHERE slug = ${slug}`,
      )) as unknown as { id: string }[];
      return rows[0]?.id;
    },
  );
  if (!id) throw new Error(`provisionSchemaFor: no plugin row for ${slug}`);
  const emitted = schemaFromSpec({ pluginId: id, slug, schema });
  await adapter.provisionPluginPublicSchema({ pluginId: id, sql: emitted.sql });
}

async function bootstrapForms(): Promise<void> {
  await bootstrapPluginHost({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: formsPlugin }],
  });
  await provisionSchemaFor("forms", formsPlugin.schema);
}

let savedCaptcha: { provider: string; prefix: string } | undefined;

/** Read and overwrite the gateway's captcha settings (system-scoped). */
async function captchaSettings(next?: {
  provider: string;
  prefix: string;
}): Promise<{ provider: string; prefix: string } | undefined> {
  const adminSql = new SQL(ADMIN_URL as string);
  try {
    return await adminSql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const [row] = (await tx`
        SELECT captcha_provider AS provider, captcha_pow_target_prefix AS prefix
        FROM site_settings WHERE id = 1`) as { provider: string; prefix: string }[];
      if (next) {
        await tx`UPDATE site_settings SET captcha_provider = ${next.provider},
                 captcha_pow_target_prefix = ${next.prefix} WHERE id = 1`;
      }
      return row;
    });
  } finally {
    await adminSql.end();
  }
}

/**
 * A solved PoW proof, as the forms Web Component attaches one (#634: the
 * plugin's captcha check follows the gateway's verification in every
 * environment, so a gateway submission without one is refused).
 */
async function captchaProof(): Promise<{ _caelo_captcha: { challenge: string; nonce: string } }> {
  const c = await handleRequest(new Request("http://localhost/api/captcha/challenge"));
  const { challenge, target } = (
    (await c.json()) as { data: { challenge: string; target: string } }
  ).data;
  for (let nonce = 0; ; nonce++) {
    const hex = new Bun.CryptoHasher("sha256").update(`${challenge}${nonce}`).digest("hex");
    if (hex.startsWith(target)) return { _caelo_captcha: { challenge, nonce: String(nonce) } };
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  // P13 — gateway needs an adapter handle for body cap, signed cookies,
  // rate limit, captcha, request log middleware.
  // #635 — the gateway's own identity: public_role on cms_public only,
  // serving from what the admin published.
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: PUBLIC_ROLE_URL,
    expectedRoles: { admin: null, public: ["public_role"] },
  });
  setGatewayAdapter(gatewayAdapter);
  // One hex digit keeps the proofs cheap to compute.
  savedCaptcha = await captchaSettings({ provider: "pow", prefix: "0" });
  await publishProjectionOnce(adapter, { declarations: new Map(), comments: false });
  invalidateGatewaySettings();
});

afterEach(async () => {
  await wipe();
  invalidateGatewaySettings();
});

afterAll(async () => {
  if (savedCaptcha) await captchaSettings(savedCaptcha);
  invalidateGatewaySettings();
  await adapter.close();
  await gatewayAdapter.close();
});

// Stale-comment fix (#387): these ops do NOT spawn Deno subprocesses —
// Tier-1 plugins run in-process and the Tier-2 Deno runtime is a stub
// (Tier2RuntimePending). The raised budget is still needed for the real
// reason: under the full `bun test --isolate` run the many parallel
// real-Postgres fixtures contend for CPU/connections and the default 30s
// per-test budget can be exceeded even though these tests finish quickly
// in isolation.
setDefaultTimeout(120_000);

describe("Forms plugin end-to-end (P12 PR2)", () => {
  it("create_form + submit (via gateway) + list_submissions round-trip", async () => {
    await bootstrapForms();

    // Owner creates the form definition (admin context — direct dispatch).
    const create = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "create_form",
      args: {
        slug: FORM_SLUG,
        displayName: "Contact Us",
        schemaJson: {
          fields: [
            { name: "email", type: "email" },
            { name: "message", type: "text" },
          ],
        },
      },
    });
    expect(create.ok).toBe(true);

    // Visitor POSTs via the gateway. No visitor cookie without consent (#677).
    const submitReq = new Request("http://localhost/api/plugin/forms/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        formSlug: FORM_SLUG,
        pageId: "00000000-0000-0000-0000-000000000001",
        data: { email: "alice@example.com", message: "hello!" },
        ...(await captchaProof()),
      }),
    });
    const submitRes = await handleRequest(submitReq);
    expect(submitRes.status).toBe(200);
    const submitBody = (await submitRes.json()) as { ok: boolean; data: { submissionId: string } };
    expect(submitBody.ok).toBe(true);
    expect(submitBody.data.submissionId).toMatch(/^[0-9a-f-]{36}$/);

    expect(submitRes.headers.get("set-cookie")).toBeNull();

    // Admin lists the submission.
    const list = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: { formSlug: FORM_SLUG },
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const submissions = (
      list.value as {
        submissions: Array<{
          id: string;
          form_slug: string;
          visitor_id: string | null;
          status: string;
          data: { email: string; message: string };
        }>;
      }
    ).submissions;
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.form_slug).toBe(FORM_SLUG);
    expect(submissions[0]?.status).toBe("new");
    expect(submissions[0]?.visitor_id).toBeNull();
    expect(submissions[0]?.data.email).toBe("alice@example.com");
  });

  it("mark_read + archive flip status correctly", async () => {
    await bootstrapForms();
    await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "create_form",
      args: { slug: FORM_SLUG, displayName: "C", schemaJson: {} },
    });
    const sub = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "submit",
      args: { formSlug: FORM_SLUG, data: { x: 1 } },
    });
    if (!sub.ok) throw new Error("submit failed");
    const id = (sub.value as { submissionId: string }).submissionId;

    const r1 = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "mark_read",
      args: { submissionId: id },
    });
    expect(r1.ok).toBe(true);
    const after1 = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: {},
    });
    if (!after1.ok) return;
    expect(
      (after1.value as { submissions: Array<{ status: string }> }).submissions[0]?.status,
    ).toBe("read");

    const r2 = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "archive",
      args: { submissionId: id },
    });
    expect(r2.ok).toBe(true);
    const after2 = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: { status: "archived" },
    });
    if (!after2.ok) return;
    expect(
      (after2.value as { submissions: Array<{ status: string }> }).submissions[0]?.status,
    ).toBe("archived");
  });

  it("set_submission_status (the AI tool's op) changes many rows and validates input", async () => {
    await bootstrapForms();
    const sys = { origin: "system" as const, actorId: "00000000-0000-0000-0000-000000000000" };
    await runPluginOperation({
      invocation: sys,
      pluginSlug: "forms",
      operationName: "create_form",
      args: { slug: FORM_SLUG, displayName: "C", schemaJson: {} },
    });
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const sub = await runPluginOperation({
        invocation: sys,
        pluginSlug: "forms",
        operationName: "submit",
        args: { formSlug: FORM_SLUG, data: { n } },
      });
      if (!sub.ok) throw new Error("submit failed");
      ids.push((sub.value as { submissionId: string }).submissionId);
    }
    const r = await runPluginOperation({
      invocation: sys,
      pluginSlug: "forms",
      operationName: "set_submission_status",
      args: { submissionIds: ids, status: "archived" },
    });
    expect(r.ok).toBe(true);
    const archived = await runPluginOperation({
      invocation: sys,
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: { status: "archived" },
    });
    if (!archived.ok) throw new Error("list failed");
    expect((archived.value as { submissions: unknown[] }).submissions).toHaveLength(2);

    const bad = await runPluginOperation({
      invocation: sys,
      pluginSlug: "forms",
      operationName: "set_submission_status",
      args: { submissionIds: ids, status: "deleted" },
    });
    expect(bad.ok).toBe(false);

    // One unknown id refuses the whole batch: nothing moves to `read`.
    const partial = await runPluginOperation({
      invocation: sys,
      pluginSlug: "forms",
      operationName: "set_submission_status",
      args: { submissionIds: [...ids, crypto.randomUUID()], status: "read" },
    });
    expect(partial.ok).toBe(false);
    const read = await runPluginOperation({
      invocation: sys,
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: { status: "read" },
    });
    if (!read.ok) throw new Error("list failed");
    expect((read.value as { submissions: unknown[] }).submissions).toHaveLength(0);
  });

  it("submit refuses unknown form slug", async () => {
    await bootstrapForms();
    const r = await handleRequest(
      new Request("http://localhost/api/plugin/forms/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formSlug: "no-such-form",
          data: { x: 1 },
          ...(await captchaProof()),
        }),
      }),
    );
    expect(r.status).toBe(500); // OperationFailed surfaced as 500
    const body = (await r.json()) as { ok: boolean; error: { kind: string; message: string } };
    expect(body.error.message).toContain("no form with slug");
  });

  it("cross-plugin isolation: another plugin can't read forms data", async () => {
    const otherPlugin = definePlugin({
      slug: "test-p12-other",
      version: "1.0.0",
      tier: 1,
      schema: {
        // Same shape, different schema — RLS should still isolate.
        form_submissions: {
          id: "uuid",
          form_slug: "string",
          page_id: "string",
          locale: "string",
          visitor_id: "string",
          data: "jsonb",
          status: "enum:new,read,archived,spam",
          submitted_at: "timestamp",
        },
      },
      operations: {
        peek: async (ctx) => ctx.query.list("form_submissions", { limit: 100 }),
      },
    });
    await bootstrapPluginHost({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: formsPlugin }, { definition: otherPlugin }],
    });
    await provisionSchemaFor("forms", formsPlugin.schema);
    await provisionSchemaFor("test-p12-other", otherPlugin.schema);

    // Forms plugin: create + submit one row.
    await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "create_form",
      args: { slug: FORM_SLUG, displayName: "C", schemaJson: {} },
    });
    await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "forms",
      operationName: "submit",
      args: { formSlug: FORM_SLUG, data: { secret: "value" } },
    });

    // Other plugin reading its own form_submissions table sees nothing.
    const peek = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "test-p12-other",
      operationName: "peek",
      args: {},
    });
    expect(peek.ok).toBe(true);
    if (!peek.ok) return;
    expect((peek.value as unknown[]).length).toBe(0);
  });
});
