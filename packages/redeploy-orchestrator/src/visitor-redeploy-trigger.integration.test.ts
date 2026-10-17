// SPDX-License-Identifier: MPL-2.0

/**
 * PR #844 — the orchestrator tick only arms a redeploy for visitor plugin
 * op events (#635) that resolve to a page. Before the fix, any allowlisted
 * visitor event armed the debounce timer, so a flood of events naming no
 * page (forged ids, ratings on deleted pages) each triggered a full-site
 * rebuild. Real Postgres + the real ratings plugin schema; the redeploy
 * itself is observed through spy ops so no build runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import {
  bootstrap as bootstrapPluginHost,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import ratingsPlugin from "@caelo-cms/plugin-ratings";
import { schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { commitVisitorWatermark, startRedeployOrchestrator } from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "pr844-visitor-redeploy",
};
const PFX = "vr844-";
const OP = "ratings.submit";
const EVENT_PLUGIN_ID = "11111111-2222-4333-8444-555555555555";
const POLL_MS = 25;

let adapter: DatabaseAdapter;
let adminRegistry: OperationRegistry;
let gateway: SQL;
let pageId: string;
let ratingId: string;
let prevSettings: {
  enabled: boolean;
  debounce_ms: number;
  op_kinds: string[];
  last_seen_at: string;
} | null = null;

/** Every automatic redeploy the orchestrator fired, as the page ids it passed. */
const redeploys: string[][] = [];

/**
 * The orchestrator's registry: spies for the two ops an automatic
 * redeploy runs, so the test sees whether (and for which pages) a
 * redeploy fired without building anything.
 */
function spyRegistry(): OperationRegistry {
  const reg = new OperationRegistry();
  reg.register(
    defineOperation({
      name: "quality_audits.plan_auto_redeploy",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({ changedPageIds: z.array(z.string()) }),
      output: z.object({
        auditNeeded: z.boolean(),
        reasons: z.array(z.string()),
        pageIds: z.array(z.string()),
      }),
      handler: async (_ctx, input) => {
        redeploys.push([...input.changedPageIds]);
        return { ok: true, value: { auditNeeded: false, reasons: [], pageIds: [] } };
      },
    }),
  );
  reg.register(
    defineOperation({
      name: "deploy.trigger",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({
        targetName: z.string(),
        changedPageIds: z.array(z.string()).optional(),
      }),
      output: z.object({ runId: z.string() }),
      handler: async () => ({ ok: true, value: { runId: "spy" } }),
    }),
  );
  return reg;
}

async function withAdminSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    let out: T | undefined;
    await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out as T;
  } finally {
    await conn.end();
  }
}

/** Remove this file's rows and the ratings plugin (templates survive the per-file reset). */
async function wipe(): Promise<void> {
  resetPluginHost();
  await withAdminSql(async (tx) => {
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'ratings'))`;
    await tx`DELETE FROM site_snapshots WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'ratings'))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'ratings')`;
    await tx`DELETE FROM plugin_schema_migrations
             WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'ratings')`;
    await tx`DELETE FROM plugins WHERE slug = 'ratings'`;
  });
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    await pub.unsafe("DROP SCHEMA IF EXISTS plugin_ratings CASCADE");
  } finally {
    await pub.end();
  }
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(adminRegistry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function watermark(): Promise<string> {
  const rows = await withAdminSql(
    async (tx) =>
      (await tx`SELECT auto_redeploy_last_public_event_id::text AS id
                FROM site_settings WHERE id = 1`) as unknown as { id: string }[],
  );
  return rows[0]?.id ?? "0";
}

/** Insert one event as the gateway does (public_role); returns its id. */
async function gatewayEvent(entityId: string): Promise<string> {
  await gateway`
    INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, entity_id)
    VALUES (${EVENT_PLUGIN_ID}::uuid, ${OP}, ${"c".repeat(64)}, true, ${entityId}::uuid)`;
  // public_role may insert but not read back; look the id up as the system.
  const rows = (await adapter.withPublicTransaction(
    SYS,
    async (tx) =>
      await tx.execute(sql`
        SELECT max(id)::text AS id FROM gateway_plugin_op_events
        WHERE entity_id = ${entityId}::uuid`),
  )) as unknown as { id: string | null }[];
  const id = rows[0]?.id;
  if (!id) throw new Error("gateway event not found after insert");
  return id;
}

/**
 * Run the orchestrator until its tick has consumed event `eventId` (the
 * watermark reached it), give the rest of that tick a few polls to arm or
 * skip the debounce timer, then fire whatever is pending.
 */
async function runUntilConsumed(eventId: string): Promise<void> {
  const handle = startRedeployOrchestrator({
    adapter,
    registry: spyRegistry(),
    pollIntervalMs: POLL_MS,
  });
  try {
    const deadline = Date.now() + 10_000;
    while (BigInt(await watermark()) < BigInt(eventId)) {
      if (Date.now() > deadline) throw new Error(`event ${eventId} never consumed`);
      await Bun.sleep(POLL_MS);
    }
    await Bun.sleep(POLL_MS * 8);
    await handle.flushPending();
  } finally {
    handle.stop();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  adminRegistry = new OperationRegistry();
  registerAdminOps(adminRegistry);
  gateway = new SQL(PUBLIC_URL as string);
  await wipe();

  const { templateId } = await op<{ templateId: string }>("templates.create", {
    slug: `${PFX}tpl`,
    displayName: "T",
    html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  ({ pageId } = await op<{ pageId: string }>("pages.create", {
    slug: `${PFX}rated`,
    title: "Rated",
    templateId,
  }));

  // The real ratings plugin and its cms_public schema, so the orchestrator
  // resolves a rating id to its page exactly as in production.
  await bootstrapPluginHost({
    infra: { adapter, registry: adminRegistry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYS.actorId,
    testPlugins: [{ definition: ratingsPlugin }],
  });
  const ratingsPluginId = await adapter.withAdminTransaction(SYS, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT id::text AS id FROM plugins WHERE slug = 'ratings'`,
    )) as unknown as { id: string }[];
    return rows[0]?.id;
  });
  if (!ratingsPluginId) throw new Error("ratings plugin row missing after bootstrap");
  const emitted = schemaFromSpec({
    pluginId: ratingsPluginId,
    slug: "ratings",
    schema: ratingsPlugin.schema ?? {},
  });
  await adapter.provisionPluginPublicSchema({ pluginId: ratingsPluginId, sql: emitted.sql });
  const submitted = await runPluginOperation({
    invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
    pluginSlug: "ratings",
    operationName: "submit",
    args: { pageId, score: 5 },
  });
  if (!submitted.ok) throw new Error(`ratings.submit: ${JSON.stringify(submitted.error)}`);
  ratingId = await adapter.public.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('caelo.actor_kind', 'system', true)`);
    await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${ratingsPluginId}, true)`);
    const rows = (await tx.execute(
      sql`SELECT id::text AS id FROM plugin_ratings.ratings WHERE page_id = ${pageId}`,
    )) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("rating row missing after submit");
    return id;
  });

  // Auto-redeploy on for visitor ratings only, with a debounce long
  // enough that only flushPending() fires it. last_seen_at = now() keeps
  // the plugin's own audit rows from above out of the tick: what the tick
  // sees is the visitor events alone.
  await withAdminSql(async (tx) => {
    const rows = (await tx`
      SELECT auto_redeploy_enabled AS enabled, auto_redeploy_debounce_ms AS debounce_ms,
             auto_redeploy_op_kinds AS op_kinds, auto_redeploy_last_seen_at::text AS last_seen_at
      FROM site_settings WHERE id = 1`) as unknown as NonNullable<typeof prevSettings>[];
    prevSettings = rows[0] ?? null;
    await tx`UPDATE site_settings
             SET auto_redeploy_enabled = true, auto_redeploy_debounce_ms = 600000,
                 auto_redeploy_op_kinds = string_to_array(${OP}, ','), auto_redeploy_last_seen_at = now()
             WHERE id = 1`;
  });
});

beforeEach(async () => {
  redeploys.length = 0;
  // Start at the sequence's current value (the per-file reset restarts
  // the sequence; a watermark left by an earlier file may be ahead of it).
  const conn = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    const [row] = (await conn`
      SELECT COALESCE(pg_sequence_last_value('gateway_plugin_op_events_id_seq'::regclass), 0)::text
        AS last`) as { last: string }[];
    await commitVisitorWatermark(adapter, row?.last ?? "0");
  } finally {
    await conn.end();
  }
});

afterAll(async () => {
  if (prevSettings) {
    const p = prevSettings;
    await withAdminSql(async (tx) => {
      await tx`UPDATE site_settings
               SET auto_redeploy_enabled = ${p.enabled}, auto_redeploy_debounce_ms = ${p.debounce_ms},
                   auto_redeploy_op_kinds = string_to_array(${p.op_kinds.join(",")}, ','),
                   auto_redeploy_last_seen_at = ${p.last_seen_at}::timestamptz
               WHERE id = 1`;
    });
  }
  await wipe();
  await gateway.end();
  await adapter.close();
});

describe("visitor plugin op events and the automatic redeploy (PR #844)", () => {
  it("events that resolve to no page trigger no redeploy, and the watermark still moves past them", async () => {
    // A rating id that does not exist: the event names no page.
    const eventId = await gatewayEvent("00000000-0000-4000-8000-0000000000aa");
    await runUntilConsumed(eventId);
    expect(redeploys).toEqual([]);
    // Consumed, not left behind to be re-read every tick.
    expect(await watermark()).toBe(eventId);
  });

  it("an event that resolves to a page redeploys that page", async () => {
    const eventId = await gatewayEvent(ratingId);
    await runUntilConsumed(eventId);
    expect(redeploys).toEqual([[pageId]]);
    expect(await watermark()).toBe(eventId);
  });
});
