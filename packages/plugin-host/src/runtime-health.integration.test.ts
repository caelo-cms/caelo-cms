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
 *   - a core problem goes to the bug intake once per fingerprint, also
 *     when several instances hit it at once;
 *   - an operation that throws lands in the plugin's error log;
 *   - `plugins.get` shows all of it as health;
 *   - a plugin that never verified (no row) is listed as a discovery
 *     failure instead of vanishing;
 *   - `failed` is no longer a status the database accepts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  hostInstanceId,
  recordPluginError,
  recordPluginRuntime,
  runtimeHeartbeatOnce,
  unsavedRuntimeSlugs,
} from "./runtime-health.js";

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
      problem: { phase: "activate", errorClass: "plugin", report: "none" },
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
    // Bug forwarding is off by default: the report stays on this site, and
    // health says so instead of claiming the Caelo team was told.
    const listed = await execute(registry, adapter, SYSTEM, "plugins.list", {});
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const failure = (
      listed.value as { discoveryFailures: { slug: string; report: string }[] }
    ).discoveryFailures.find((f) => f.slug === slug);
    expect(failure?.report).toBe("local");
  });

  it("retries the bug intake on the next occurrence when the first report was refused", async () => {
    const slug = `${PREFIX}core-retry`;
    const error = () =>
      Object.assign(new Error("syntax error at or near TABLE"), { errno: "42601" });
    // A registry without the bug-report op: the intake refuses the report.
    const refused = await recordPluginError({
      infra: { adapter, registry: new OperationRegistry() },
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      pluginId: null,
      phase: "provision",
      error: error(),
    });
    expect(refused).toMatchObject({ firstOccurrence: true, reported: false });
    const retried = await recordPluginError({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      pluginId: null,
      phase: "provision",
      error: error(),
    });
    expect(retried).toMatchObject({ firstOccurrence: false, reported: true });
    expect((await errorsOf(slug))[0]?.bug_report_id).not.toBeNull();
  });

  it("files one report when several instances hit the same core problem at once", async () => {
    const slug = `${PREFIX}core-race`;
    const occur = () =>
      recordPluginError({
        infra,
        systemActorId: SYSTEM_ACTOR_ID,
        slug,
        pluginId: null,
        phase: "provision",
        error: Object.assign(new Error("syntax error at or near INDEX"), { errno: "42601" }),
      });
    const results = await Promise.all([occur(), occur(), occur(), occur(), occur()]);
    expect(results.every((r) => r !== null)).toBe(true);
    const reports = await withSystemSql(
      async (tx) =>
        (await tx`
          SELECT id::text AS id FROM ai_bug_reports
          WHERE title = ${`Plugin host: ${slug} failed in provision`}
        `) as { id: string }[],
    );
    expect(reports).toHaveLength(1);
    const errors = await errorsOf(slug);
    expect(errors[0]).toMatchObject({ occurrences: 5, bug_report_id: reports[0]?.id });
  });

  it("takes over a bug-intake claim its holder abandoned", async () => {
    const slug = `${PREFIX}core-stale`;
    const occur = () =>
      recordPluginError({
        infra: { adapter, registry: new OperationRegistry() },
        systemActorId: SYSTEM_ACTOR_ID,
        slug,
        pluginId: null,
        phase: "provision",
        error: Object.assign(new Error("syntax error at or near VIEW"), { errno: "42601" }),
      });
    await occur();
    // An instance that claimed the filing and died before linking or
    // releasing it: a fresh claim blocks, a lapsed one does not.
    const hold = (age: string) =>
      withSystemSql(async (tx) => {
        await tx`
          UPDATE plugin_errors
          SET bug_intake_claim = gen_random_uuid(),
              bug_intake_claimed_at = now() - ${age}::interval
          WHERE plugin_slug = ${slug}
        `;
      });
    const withIntake = () =>
      recordPluginError({
        infra,
        systemActorId: SYSTEM_ACTOR_ID,
        slug,
        pluginId: null,
        phase: "provision",
        error: Object.assign(new Error("syntax error at or near VIEW"), { errno: "42601" }),
      });
    await hold("1 minute");
    expect(await withIntake()).toMatchObject({ reported: false });
    expect((await errorsOf(slug))[0]?.bug_report_id).toBeNull();
    await hold("11 minutes");
    expect(await withIntake()).toMatchObject({ reported: true });
    expect((await errorsOf(slug))[0]?.bug_report_id).not.toBeNull();
  });

  it("uninstalling a plugin that is failing to load removes its runtime and error rows", async () => {
    const slug = `${PREFIX}uninstall`;
    await boot({
      slug,
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: { noop: async () => ({}) },
      onActivate: async () => {
        throw new Error("never comes up");
      },
    });
    expect((await runtimeOf(slug)).map((r) => r.state)).toEqual(["error"]);
    // The uninstall op ends in this DELETE; the error row cascades and must
    // take the runtime row with it instead of breaking its CHECK.
    await withSystemSql(async (tx) => {
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
      await tx`DELETE FROM plugins WHERE slug = ${slug}`;
    });
    expect(await errorsOf(slug)).toEqual([]);
    expect(await runtimeOf(slug)).toEqual([]);
  });

  it("an unreadable manifest of an active plugin counts as failing here", async () => {
    const slug = `${PREFIX}badmanifest`;
    await boot({
      slug,
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: { noop: async () => ({}) },
    });
    expect(await statusOf(slug)).toBe("active");
    const root = mkdtempSync(join(tmpdir(), "t1008-"));
    try {
      mkdirSync(join(root, slug));
      writeFileSync(join(root, slug, "manifest.json"), "{ not json");
      resetPluginHost();
      const report = await bootstrap({ infra, pluginsRoot: root, systemActorId: SYSTEM_ACTOR_ID });
      expect(report.failed.map((f) => f.slug)).toContain(slug);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(await statusOf(slug)).toBe("active");
    expect((await runtimeOf(slug)).map((r) => r.state)).toEqual(["error"]);
    const got = await execute(registry, adapter, SYSTEM, "plugins.get", { slug });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect(
      (got.value as { plugin: { health: { state: string; problem: { phase: string } } } }).plugin
        .health,
    ).toMatchObject({ state: "failing", problem: { phase: "verify" } });
  });

  it("a plugin that fails verification on first discovery is listed as found-but-not-verified", async () => {
    const slug = `${PREFIX}undiscovered`;
    // What the loader records for a disk plugin whose signature does not
    // verify before it ever had a row: an error with no plugin behind it.
    await recordPluginError({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      pluginId: null,
      phase: "verify",
      error: new Error("manifest signature does not verify"),
    });
    const listed = await execute(registry, adapter, SYSTEM, "plugins.list", {});
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const value = listed.value as {
      plugins: { slug: string }[];
      discoveryFailures: { slug: string; phase: string; message: string }[];
    };
    expect(value.plugins.map((p) => p.slug)).not.toContain(slug);
    expect(value.discoveryFailures.find((f) => f.slug === slug)).toMatchObject({
      phase: "verify",
      message: expect.stringContaining("signature does not verify"),
    });
    // plugins.get names the failure and the fix instead of "no plugin".
    const got = await execute(registry, adapter, SYSTEM, "plugins.get", { slug });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect("message" in got.error ? got.error.message : "").toContain("is not installed");

    // Once it verifies and is installed, it is an ordinary plugin again.
    const report = await boot({
      slug,
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: { noop: async () => ({}) },
    });
    expect(report.loaded.map((l) => l.slug)).toEqual([slug]);
    const after = await execute(registry, adapter, SYSTEM, "plugins.list", {});
    if (!after.ok) throw new Error(JSON.stringify(after.error));
    const afterValue = after.value as {
      plugins: { slug: string }[];
      discoveryFailures: { slug: string }[];
    };
    expect(afterValue.plugins.map((p) => p.slug)).toContain(slug);
    expect(afterValue.discoveryFailures.map((f) => f.slug)).not.toContain(slug);
    const gotAfter = await execute(registry, adapter, SYSTEM, "plugins.get", { slug });
    expect(gotAfter.ok).toBe(true);
  });

  it("writes a runtime state the database refused on the next heartbeat", async () => {
    const slug = `${PREFIX}lost-write`;
    let failNext = true;
    // The admin database drops the connection for exactly one transaction.
    const flaky = new Proxy(adapter, {
      get(target, prop) {
        if (prop === "withAdminTransaction" && failNext) {
          failNext = false;
          return async () => {
            throw Object.assign(new Error("connection lost"), { errno: "08006" });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await recordPluginRuntime({
      infra: { adapter: flaky, registry },
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      state: "loaded",
      errorId: null,
    });
    expect(await runtimeOf(slug)).toEqual([]);
    expect(unsavedRuntimeSlugs()).toContain(slug);

    await runtimeHeartbeatOnce(infra, SYSTEM_ACTOR_ID);
    expect((await runtimeOf(slug)).map((r) => r.state)).toEqual(["loaded"]);
    expect(unsavedRuntimeSlugs()).not.toContain(slug);
  });

  it("a heartbeat retry of an older outcome never overwrites a newer one", async () => {
    const slug = `${PREFIX}retry-race`;
    // An `error` outcome needs its error row.
    const recorded = await recordPluginError({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      pluginId: null,
      phase: "activate",
      error: new Error("still starting"),
    });
    if (!recorded) throw new Error("plugin error not recorded");
    // 1. The `error` outcome's write is refused once and stays pending.
    let refuse = true;
    const refusing = new Proxy(adapter, {
      get(target, prop) {
        if (prop === "withAdminTransaction" && refuse) {
          refuse = false;
          return async () => {
            throw Object.assign(new Error("connection lost"), { errno: "08006" });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await recordPluginRuntime({
      infra: { adapter: refusing, registry },
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      state: "error",
      errorId: recorded.errorId,
    });
    expect(unsavedRuntimeSlugs()).toContain(slug);
    // 2. The heartbeat retries it on a slow connection: its transaction
    //    commits only after the next outcome was recorded.
    const slow = new Proxy(adapter, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === "withAdminTransaction") {
          return async (...args: unknown[]) => {
            await Bun.sleep(300);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const retry = runtimeHeartbeatOnce({ adapter: slow, registry }, SYSTEM_ACTOR_ID);
    // 3. The plugin loads meanwhile.
    await recordPluginRuntime({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      slug,
      state: "loaded",
      errorId: null,
    });
    await retry;
    expect((await runtimeOf(slug)).map((r) => r.state)).toEqual(["loaded"]);
    expect(unsavedRuntimeSlugs()).not.toContain(slug);
  });

  it("the database no longer accepts `failed` as a status", async () => {
    const slug = `${PREFIX}check`;
    await boot({
      slug,
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: { noop: async () => ({}) },
    });
    const refused = await withSystemSql(
      async (tx) => tx`UPDATE plugins SET status = 'failed' WHERE slug = ${slug}`,
    ).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).message)).toContain("plugins_status_check");
    expect(await statusOf(slug)).toBe("active");
  });
});
