// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — a plugin that fails to load is never switched off; the failure
 * is recorded, retried when transient, and surfaced as health.
 *
 * The 2026-10-22 incident: a load failure on one instance wrote
 * `plugins.status = 'failed'` for the whole site. These tests pin the
 * replacement contract against real Postgres:
 *   - a failing load leaves `status` exactly as the Owner set it, records
 *     the problem in `plugin_errors` and this instance's `plugin_runtime`
 *     row, and leaves nothing of the plugin registered;
 *   - a transient failure is retried and the plugin comes up;
 *   - a core problem goes to the bug intake once per fingerprint;
 *   - an operation that throws lands in the plugin's error log;
 *   - `plugins.get` shows all of it as health;
 *   - `failed` is no longer a status the database accepts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  bootstrap,
  loadedPlugins,
  type PluginHostInfra,
  pluginToolsRegistry,
  resetPluginHost,
  runPluginOperation,
} from "./index.js";
import { hostInstanceId, recordPluginError } from "./runtime-health.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1008-runtime-health",
};
const PREFIX = "t1008-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

async function withSystemSql<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  await withSystemSql(async (tx) => {
    await tx`DELETE FROM plugin_runtime WHERE plugin_slug LIKE ${`${PREFIX}%`}`;
    await tx`DELETE FROM plugin_errors WHERE plugin_slug LIKE ${`${PREFIX}%`}`;
    await tx`DELETE FROM ai_bug_reports WHERE suspected_tool LIKE 'plugin-host:%' AND title LIKE ${`%${PREFIX}%`}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE ${`${PREFIX}%`}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE ${`${PREFIX}%`})`;
    await tx`DELETE FROM plugins WHERE slug LIKE ${`${PREFIX}%`}`;
  });
}

async function statusOf(slug: string): Promise<string | undefined> {
  return withSystemSql(
    async (tx) =>
      ((await tx`SELECT status FROM plugins WHERE slug = ${slug}`) as { status: string }[])[0]
        ?.status,
  );
}

async function errorsOf(slug: string) {
  return withSystemSql(
    async (tx) =>
      (await tx`
        SELECT phase, error_class, message, occurrences, bug_report_id::text AS bug_report_id
        FROM plugin_errors WHERE plugin_slug = ${slug} ORDER BY last_seen_at
      `) as {
        phase: string;
        error_class: string;
        message: string;
        occurrences: number;
        bug_report_id: string | null;
      }[],
  );
}

async function runtimeOf(slug: string) {
  return withSystemSql(
    async (tx) =>
      (await tx`
        SELECT instance_id, state, error_id::text AS error_id
        FROM plugin_runtime WHERE plugin_slug = ${slug}
      `) as { instance_id: string; state: string; error_id: string | null }[],
  );
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await adapter.close();
});

function boot(definition: Parameters<typeof definePlugin>[0]) {
  return bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: definePlugin(definition) }],
  });
}

describe("#1008 — a failing load never switches a plugin off", () => {
  it("records the failure, keeps status active, and leaves nothing registered", async () => {
    const slug = `${PREFIX}throws`;
    const report = await boot({
      slug,
      version: "0.1.0",
      tier: 1,
      schema: {},
      requestedCapabilities: ["chat_runner_tools"],
      tools: [
        {
          name: "t1008_tool",
          description: "x",
          inputJsonSchema: { type: "object", properties: {}, additionalProperties: false },
          operationName: "noop",
        },
      ],
      operations: { noop: async () => ({}) },
      onActivate: async () => {
        throw new Error("seed row refused");
      },
    });
    expect(report.failed.map((f) => f.slug)).toEqual([slug]);
    expect(report.failed[0]?.reason).toContain("seed row refused");

    expect(await statusOf(slug)).toBe("active");
    expect(loadedPlugins.bySlug(slug)).toBeUndefined();
    expect(pluginToolsRegistry.resolve("t1008_tool")).toBeNull();

    const errors = await errorsOf(slug);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "activate", error_class: "plugin", occurrences: 1 });
    expect(errors[0]?.message).toContain("seed row refused");
    // A plugin's own defect is the Owner's to see, not Caelo's bug intake.
    expect(errors[0]?.bug_report_id).toBeNull();

    const runtime = await runtimeOf(slug);
    expect(runtime).toEqual([
      { instance_id: hostInstanceId(), state: "error", error_id: expect.any(String) },
    ]);

    const got = await execute(registry, adapter, SYSTEM, "plugins.get", { slug });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const health = (got.value as { plugin: { health: Record<string, unknown> } }).plugin.health;
    expect(health).toMatchObject({
      state: "failing",
      servers: { loaded: 0, failing: 1 },
      problem: { phase: "activate", errorClass: "plugin", reported: false },
    });
  });

  it("folds a repeat into one row and counts it", async () => {
    const slug = `${PREFIX}repeat`;
    const definition = {
      slug,
      version: "0.1.0",
      tier: 1 as const,
      schema: {},
      operations: { noop: async () => ({}) },
      onActivate: async () => {
        throw new Error("still broken");
      },
    };
    await boot(definition);
    await boot(definition);
    const errors = await errorsOf(slug);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.occurrences).toBe(2);
  });

  it("retries a transient failure and comes up loaded", async () => {
    const slug = `${PREFIX}transient`;
    let calls = 0;
    const report = await boot({
      slug,
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: { noop: async () => ({}) },
      onActivate: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("could not serialize access"), { errno: "40001" });
        }
      },
    });
    expect(report.failed).toEqual([]);
    expect(report.loaded.map((l) => l.slug)).toEqual([slug]);
    expect(calls).toBe(2);
    expect(await errorsOf(slug)).toEqual([]);
    expect((await runtimeOf(slug)).map((r) => r.state)).toEqual(["loaded"]);

    const got = await execute(registry, adapter, SYSTEM, "plugins.get", { slug });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect((got.value as { plugin: { health: { state: string } } }).plugin.health.state).toBe(
      "running",
    );
  });

  it("logs an operation that throws under the plugin", async () => {
    const slug = `${PREFIX}op`;
    await boot({
      slug,
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: {
        explode: async () => {
          throw new Error("handler exploded");
        },
      },
    });
    const r = await runPluginOperation({
      invocation: { origin: "render", actorId: SYSTEM_ACTOR_ID },
      pluginSlug: slug,
      operationName: "explode",
      args: {},
    });
    expect(r.ok).toBe(false);
    const errors = await errorsOf(slug);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "render", error_class: "plugin" });
    expect(errors[0]?.message).toContain("handler exploded");
    // An operation error is logged, but the plugin is still running.
    expect((await runtimeOf(slug)).map((r) => r.state)).toEqual(["loaded"]);
  });

  it("files a core problem with the bug intake once per fingerprint", async () => {
    const slug = `${PREFIX}core`;
    const first = await recordPluginError({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      pluginId: null,
      phase: "provision",
      error: Object.assign(new Error("syntax error at or near SCHEMA"), { errno: "42601" }),
    });
    const second = await recordPluginError({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      pluginId: null,
      phase: "provision",
      error: Object.assign(new Error("syntax error at or near SCHEMA"), { errno: "42601" }),
    });
    expect(first).toMatchObject({ errorClass: "core", firstOccurrence: true });
    expect(second).toMatchObject({ errorClass: "core", firstOccurrence: false });
    const errors = await errorsOf(slug);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.bug_report_id).not.toBeNull();
    const reports = await withSystemSql(
      async (tx) =>
        (await tx`
          SELECT suspected_tool, severity, source FROM ai_bug_reports
          WHERE title = ${`Plugin host: ${slug} failed in provision`}
        `) as { suspected_tool: string; severity: string; source: string }[],
    );
    expect(reports).toEqual([
      { suspected_tool: "plugin-host:provision", severity: "blocking", source: "auto" },
    ]);
  });

  it("the database no longer accepts `failed` as a status", async () => {
    const slug = `${PREFIX}check`;
    await boot({ slug, version: "0.1.0", tier: 1, schema: {}, operations: { noop: async () => ({}) } });
    const refused = await withSystemSql(
      async (tx) => tx`UPDATE plugins SET status = 'failed' WHERE slug = ${slug}`,
    ).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).message)).toContain("plugins_status_check");
    expect(await statusOf(slug)).toBe("active");
  });
});
