// SPDX-License-Identifier: MPL-2.0

/**
 * P12 PR2.2 — Forms plugin end-to-end via the API gateway.
 *
 * Validates:
 *   - Plugin loads + cms_public schema gets provisioned (forms + form_submissions).
 *   - Owner creates a form definition (admin op).
 *   - Visitor POSTs to /api/plugin/forms/submit via the gateway → submission lands
 *     with visitor_id from the cookie.
 *   - Admin lists submissions → sees the visitor's row.
 *   - mark_read flips status; archive flips again.
 *   - submit refuses unknown form slug.
 *   - Cross-plugin RLS: a second plugin sharing schema shape can't read forms data.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
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

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const FORM_SLUG = "test-p12-contact";

let adapter: DatabaseAdapter;
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

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  // P13 — gateway needs an adapter handle for body cap, signed cookies,
  // rate limit, captcha, request log middleware.
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

describe("Forms plugin end-to-end (P12 PR2)", () => {
  it("create_form + submit (via gateway) + list_submissions round-trip", async () => {
    await bootstrapForms();

    // Owner creates the form definition (admin context — direct dispatch).
    const create = await runPluginOperation({
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
        locale: "en",
      },
    });
    expect(create.ok).toBe(true);

    // Visitor POSTs via the gateway. Cookie set on first contact.
    const submitReq = new Request("http://localhost/api/plugin/forms/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        formSlug: FORM_SLUG,
        pageId: "00000000-0000-0000-0000-000000000001",
        locale: "en",
        data: { email: "alice@example.com", message: "hello!" },
      }),
    });
    const submitRes = await handleRequest(submitReq);
    expect(submitRes.status).toBe(200);
    const submitBody = (await submitRes.json()) as { ok: boolean; data: { submissionId: string } };
    expect(submitBody.ok).toBe(true);
    expect(submitBody.data.submissionId).toMatch(/^[0-9a-f-]{36}$/);

    const visitorCookie = submitRes.headers.get("set-cookie") ?? "";
    // P13 — cookie is signed `<uuid>.<issuedAt>.<sig>`. Raw UUID is the
    // first dot-separated segment.
    const signed = visitorCookie.split("caelo_visitor_id=")[1]?.split(";")[0] ?? "";
    const visitorId = signed.split(".")[0] ?? "";
    expect(visitorId).toMatch(/^[0-9a-f-]{36}$/);

    // Admin lists the submission.
    const list = await runPluginOperation({
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
          visitor_id: string;
          status: string;
          data: { email: string; message: string };
        }>;
      }
    ).submissions;
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.form_slug).toBe(FORM_SLUG);
    expect(submissions[0]?.status).toBe("new");
    expect(submissions[0]?.visitor_id).toBe(visitorId);
    expect(submissions[0]?.data.email).toBe("alice@example.com");
  });

  it("mark_read + archive flip status correctly", async () => {
    await bootstrapForms();
    await runPluginOperation({
      pluginSlug: "forms",
      operationName: "create_form",
      args: { slug: FORM_SLUG, displayName: "C", schemaJson: {}, locale: "en" },
    });
    const sub = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "submit",
      args: { formSlug: FORM_SLUG, locale: "en", data: { x: 1 } },
    });
    if (!sub.ok) throw new Error("submit failed");
    const id = (sub.value as { submissionId: string }).submissionId;

    const r1 = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "mark_read",
      args: { submissionId: id },
    });
    expect(r1.ok).toBe(true);
    const after1 = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: {},
    });
    if (!after1.ok) return;
    expect(
      (after1.value as { submissions: Array<{ status: string }> }).submissions[0]?.status,
    ).toBe("read");

    const r2 = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "archive",
      args: { submissionId: id },
    });
    expect(r2.ok).toBe(true);
    const after2 = await runPluginOperation({
      pluginSlug: "forms",
      operationName: "list_submissions",
      args: { status: "archived" },
    });
    if (!after2.ok) return;
    expect(
      (after2.value as { submissions: Array<{ status: string }> }).submissions[0]?.status,
    ).toBe("archived");
  });

  it("submit refuses unknown form slug", async () => {
    await bootstrapForms();
    const r = await handleRequest(
      new Request("http://localhost/api/plugin/forms/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formSlug: "no-such-form",
          locale: "en",
          data: { x: 1 },
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
      pluginSlug: "forms",
      operationName: "create_form",
      args: { slug: FORM_SLUG, displayName: "C", schemaJson: {}, locale: "en" },
    });
    await runPluginOperation({
      pluginSlug: "forms",
      operationName: "submit",
      args: { formSlug: FORM_SLUG, locale: "en", data: { secret: "value" } },
    });

    // Other plugin reading its own form_submissions table sees nothing.
    const peek = await runPluginOperation({
      pluginSlug: "test-p12-other",
      operationName: "peek",
      args: {},
    });
    expect(peek.ok).toBe(true);
    if (!peek.ok) return;
    expect((peek.value as unknown[]).length).toBe(0);
  });
});
