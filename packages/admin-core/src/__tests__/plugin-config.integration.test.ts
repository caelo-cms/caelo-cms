// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin configuration as a schema (#1645), end to end against Postgres:
 *
 * - activation stores the declared defaults on main;
 * - a chat's change of a release field stays on its branch until the
 *   Stage merges it; an immediate field changes main at once and the
 *   merge does not write its old value back;
 * - an approval-gated field refuses a routine write and names the tool;
 * - entity configuration follows the branch and reaches main with the
 *   Stage (two chats on one entity follow the #620 takeover, pinned by
 *   plugin-row-draft-conflict.integration.test.ts);
 * - a new plugin version migrates what is stored: added fields get their
 *   default, dropped ones go, an invalid one resets.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  hostRowId,
  onPluginRegistered,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { releaseManifestDigest } from "@caelo-cms/plugin-sandbox";
import {
  definePlugin,
  manifestFromDefinition,
  type PluginConfigReader,
  type PluginInvocation,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SLUG = "t-pcfg";
const SCHEMA = "plugin_t_pcfg";
const PFX = "t-pcfg-";
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const AI = "00000000-0000-0000-0000-000000000a1a";
const humanCtx: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "pcfg" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

function plugin(version: string, extra: Record<string, unknown> = {}) {
  return definePlugin({
    slug: SLUG,
    version,
    tier: 1,
    schema: {},
    config: {
      results: {
        type: "int",
        label: "Results",
        description: "Hits per page.",
        effect: "query",
        min: 1,
        max: 50,
        default: 10,
      },
      note: {
        type: "string",
        label: "Note",
        description: "Internal note.",
        effect: "none",
        scope: "immediate",
        maxLength: 200,
        default: "",
      },
      cap: {
        type: "int",
        label: "Daily cap",
        description: "Cost cap.",
        effect: "none",
        gate: "approval",
        min: 0,
        max: 1000,
        default: 100,
      },
      ranking: {
        type: "group",
        label: "Ranking",
        description: "Order of hits.",
        fields: {
          mode: {
            type: "enum",
            label: "Mode",
            description: "Fusion.",
            effect: "query",
            options: [
              { value: "words", label: "Words" },
              { value: "hybrid", label: "Hybrid" },
            ],
            default: "words",
          },
        },
      },
      ...extra,
    },
    entityConfig: {
      module: {
        mode: {
          type: "enum",
          label: "Search mode",
          description: "How the module counts.",
          effect: "pages",
          options: [
            { value: "auto", label: "Auto" },
            { value: "never", label: "Never" },
          ],
          default: "auto",
        },
      },
    },
    operations: {
      read: async (ctx) => (ctx.config as PluginConfigReader).get(),
      read_module: async (ctx, args) =>
        (ctx.config as PluginConfigReader).entity("module", (args as { id: string }).id),
      configured: async (ctx) => (ctx.config as PluginConfigReader).configured("module"),
    },
  });
}

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
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const byPluginActor = `SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`;
    await tx.unsafe(`DELETE FROM plugin_row_snapshots WHERE schema_name = '${SCHEMA}'`);
    await tx.unsafe(
      `DELETE FROM plugin_config_pending_actions WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`,
    );
    await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(
      `DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`,
    );
    await tx.unsafe(`DELETE FROM plugins WHERE slug = '${SLUG}'`);
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
  });
}

interface Chat {
  readonly chatSessionId: string;
  readonly chatBranchId: string;
  readonly invocation: PluginInvocation;
  readonly ai: ExecutionContext;
}

async function newChat(title: string): Promise<Chat> {
  const r = await execute(registry, adapter, humanCtx, "chat.create_session", {
    isolation: "experiment",
    title: `${PFX}${title}`,
  });
  if (!r.ok) throw new Error("create chat");
  const { chatSessionId, chatBranchId } = r.value as {
    chatSessionId: string;
    chatBranchId: string;
  };
  return {
    chatSessionId,
    chatBranchId,
    invocation: {
      origin: "chat",
      actorId: AI,
      operatorActorId: HUMAN,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
    ai: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `pcfg-${title}`,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
  };
}

const MAIN: PluginInvocation = { origin: "owner-panel", actorId: HUMAN };

async function read(invocation: PluginInvocation): Promise<Record<string, unknown>> {
  const r = await runPluginOperation({
    pluginSlug: SLUG,
    operationName: "read",
    args: {},
    invocation,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value as Record<string, unknown>;
}

async function moduleMode(invocation: PluginInvocation, id: string): Promise<unknown> {
  const r = await runPluginOperation({
    pluginSlug: SLUG,
    operationName: "read_module",
    args: { id },
    invocation,
  });
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { mode: unknown }).mode;
}

async function load(version: string, extra: Record<string, unknown> = {}): Promise<void> {
  resetPluginHost();
  // A new manifest is a new artifact: approve it the way an Owner would.
  const digest = releaseManifestDigest(manifestFromDefinition(plugin(version, extra)));
  await withSystemSql(
    async (tx) => tx`UPDATE plugins SET approved_manifest_digest = ${digest} WHERE slug = ${SLUG}`,
  );
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: HUMAN,
    testPlugins: [{ definition: plugin(version, extra) }],
  });
  expect(report.failed).toEqual([]);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry, lockPluginRow };
  await wipe();
  await load("0.1.0");
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("plugin configuration (#1645)", () => {
  it("stores the declared defaults at activation", async () => {
    expect(await read(MAIN)).toEqual({
      results: 10,
      note: "",
      cap: 100,
      ranking: { mode: "words" },
    });
  });

  it("keeps a chat's change on its branch, applies immediate fields at once, and merges with the Stage", async () => {
    const a = await newChat("a");
    const r = await execute(registry, adapter, a.ai, "plugin_config.update", {
      pluginSlug: SLUG,
      patch: { results: 20, ranking: { mode: "hybrid" } },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect((r.value as { changed: { path: string }[] }).changed.map((c) => c.path)).toEqual([
      "results",
      "ranking.mode",
    ]);
    expect((await read(a.invocation)).results).toBe(20);
    expect((await read(MAIN)).results).toBe(10);

    const note = await execute(registry, adapter, a.ai, "plugin_config.update", {
      pluginSlug: SLUG,
      patch: { note: "seen" },
    });
    if (!note.ok) throw new Error(JSON.stringify(note.error));
    expect((await read(MAIN)).note).toBe("seen");

    // An Owner changes the immediate field again on main after the chat's snapshot.
    const owner = await execute(
      registry,
      adapter,
      { actorId: HUMAN, actorKind: "human", requestId: "pcfg-owner" },
      "plugin_config.update",
      { pluginSlug: SLUG, patch: { note: "owner" } },
    );
    if (!owner.ok) throw new Error(JSON.stringify(owner.error));

    const merged = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId: a.chatSessionId,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await read(MAIN)).toEqual({
      results: 20,
      note: "owner",
      cap: 100,
      ranking: { mode: "hybrid" },
    });
  });

  it("refuses a routine write of an approval-gated field and names the tool", async () => {
    const b = await newChat("b");
    const r = await execute(registry, adapter, b.ai, "plugin_config.update", {
      pluginSlug: SLUG,
      patch: { cap: 500, results: 5 },
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.ok ? null : r.error)).toContain("propose_plugin_config");
    expect((await read(b.invocation)).results).toBe(20);
    // `approved` from anyone but the approval path's human does nothing.
    const sneaky = await execute(registry, adapter, b.ai, "plugin_config.update", {
      pluginSlug: SLUG,
      patch: { cap: 500 },
      approved: true,
    });
    expect(sneaky.ok).toBe(false);
  });

  it("applies an approval-gated field only through an approved proposal, on main", async () => {
    const g = await newChat("g");
    const proposed = await execute(registry, adapter, g.ai, "plugin_config.propose_update", {
      pluginSlug: SLUG,
      patch: { cap: 500 },
      reason: "More traffic expected.",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId, preview } = proposed.value as {
      proposalId: string;
      preview: { changes: { path: string; before: unknown; after: unknown }[] };
    };
    expect(preview.changes).toEqual([
      expect.objectContaining({ path: "cap", before: 100, after: 500 }),
    ]);
    const dup = await execute(registry, adapter, g.ai, "plugin_config.propose_update", {
      pluginSlug: SLUG,
      patch: { cap: 500 },
      reason: "Again.",
    });
    expect(dup.ok).toBe(false);
    const listed = await execute(registry, adapter, g.ai, "pending_proposals.list", {});
    expect(JSON.stringify(listed.ok ? listed.value : null)).toContain(proposalId);
    expect(
      (await execute(registry, adapter, g.ai, "plugin_config.execute_proposal", { proposalId })).ok,
    ).toBe(false);
    const noRole = await execute(
      registry,
      adapter,
      {
        actorId: "00000000-0000-0000-0000-00000000bbbb",
        actorKind: "human",
        requestId: "pcfg-norole",
      },
      "plugin_config.execute_proposal",
      { proposalId },
    );
    expect(noRole.ok).toBe(false);
    expect((await read(MAIN)).cap).toBe(100);
    const applied = await execute(registry, adapter, humanCtx, "plugin_config.execute_proposal", {
      proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    expect((await read(MAIN)).cap).toBe(500);
    expect((await read(g.invocation)).cap).toBe(500);
    expect(
      (await execute(registry, adapter, humanCtx, "plugin_config.execute_proposal", { proposalId }))
        .ok,
    ).toBe(false);
  });

  it("refuses an approval whose field changed after the proposal", async () => {
    const h = await newChat("h");
    const first = await execute(registry, adapter, h.ai, "plugin_config.propose_update", {
      pluginSlug: SLUG,
      patch: { cap: 600 },
      reason: "A.",
    });
    const second = await execute(registry, adapter, h.ai, "plugin_config.propose_update", {
      pluginSlug: SLUG,
      patch: { cap: 700 },
      reason: "B.",
    });
    if (!first.ok || !second.ok) throw new Error("propose failed");
    const a = (first.value as { proposalId: string }).proposalId;
    const b = (second.value as { proposalId: string }).proposalId;
    expect(
      (
        await execute(registry, adapter, humanCtx, "plugin_config.execute_proposal", {
          proposalId: b,
        })
      ).ok,
    ).toBe(true);
    const stale = await execute(registry, adapter, humanCtx, "plugin_config.execute_proposal", {
      proposalId: a,
    });
    expect(stale.ok).toBe(false);
    expect(JSON.stringify(stale.ok ? null : stale.error)).toContain("changed after this proposal");
    expect((await read(MAIN)).cap).toBe(700);
    expect(
      (
        await execute(registry, adapter, humanCtx, "plugin_config.reject_proposal", {
          proposalId: a,
        })
      ).ok,
    ).toBe(true);
  });

  it("reports every invalid path of a patch", async () => {
    const c = await newChat("c");
    const r = await execute(registry, adapter, c.ai, "plugin_config.update", {
      pluginSlug: SLUG,
      patch: { results: 99, ranking: { mode: "fuzzy" }, unknown: 1 },
    });
    expect(r.ok).toBe(false);
    const message = JSON.stringify(r.ok ? null : r.error);
    expect(message).toContain("results");
    expect(message).toContain("ranking.mode");
  });

  it("keeps entity configuration on the branch, defaults elsewhere, and merges it with the Stage", async () => {
    const moduleId = "11111111-2222-4333-8444-555555555555";
    const d = await newChat("d");
    const e = await newChat("e");
    const set = await execute(registry, adapter, d.ai, "plugin_config.set_entities", {
      pluginSlug: SLUG,
      items: [{ kind: "module", id: moduleId, values: { mode: "never" } }],
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    expect(await moduleMode(d.invocation, moduleId)).toBe("never");
    expect(await moduleMode(MAIN, moduleId)).toBe("auto");
    expect(await moduleMode(e.invocation, moduleId)).toBe("auto");
    const bad = await execute(registry, adapter, d.ai, "plugin_config.set_entities", {
      pluginSlug: SLUG,
      items: [{ kind: "page", id: moduleId, values: { mode: "never" } }],
    });
    expect(bad.ok).toBe(false);
    const merged = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId: d.chatSessionId,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await moduleMode(MAIN, moduleId)).toBe("never");
    const configured = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "configured",
      args: {},
      invocation: MAIN,
    });
    expect(configured.ok && configured.value).toEqual([moduleId]);
    // A later chat clears the field: null takes the default again, on its branch only.
    const f = await newChat("f");
    const cleared = await execute(registry, adapter, f.ai, "plugin_config.set_entities", {
      pluginSlug: SLUG,
      items: [{ kind: "module", id: moduleId, values: { mode: null } }],
    });
    if (!cleared.ok) throw new Error(JSON.stringify(cleared.error));
    expect(await moduleMode(f.invocation, moduleId)).toBe("auto");
    expect(await moduleMode(MAIN, moduleId)).toBe("never");
  });

  it("migrates the stored value when a new version changes the schema", async () => {
    await load("0.2.0", {
      cap: {
        type: "int",
        label: "Daily cap",
        description: "Cost cap.",
        effect: "none",
        gate: "approval",
        min: 0,
        max: 50,
        default: 25,
      },
      semantic: {
        type: "bool",
        label: "Semantic",
        description: "By meaning.",
        effect: "rebuild",
        default: false,
      },
    });
    const value = await read(MAIN);
    expect(value.semantic).toBe(false);
    // The stored 700 no longer fits max 50: reset to the new default.
    expect(value.cap).toBe(25);
    expect(value.results).toBe(20);
  });

  it("announces a plugin to its listeners only once the registration is complete (#1646)", async () => {
    // The activation batch listens here: it must find the configuration
    // stored and whatever onActivate prepared, never a plugin halfway in.
    let activated = false;
    const seen: { activated: boolean; results: unknown }[] = [];
    const off = onPluginRegistered(async (p) => {
      if (p.slug !== SLUG) return;
      const r = await runPluginOperation({
        invocation: MAIN,
        pluginSlug: SLUG,
        operationName: "read",
        args: {},
      });
      seen.push({ activated, results: r.ok ? (r.value as { results: unknown }).results : r.error });
    });
    try {
      const slow = definePlugin({
        ...plugin("0.3.0"),
        onActivate: async () => {
          await Bun.sleep(200);
          activated = true;
        },
      });
      resetPluginHost();
      const digest = releaseManifestDigest(manifestFromDefinition(slow));
      await withSystemSql(
        async (tx) =>
          tx`UPDATE plugins SET approved_manifest_digest = ${digest} WHERE slug = ${SLUG}`,
      );
      const report = await bootstrap({
        infra,
        pluginsRoot: "/dev/null/unused",
        systemActorId: HUMAN,
        testPlugins: [{ definition: slow }],
      });
      expect(report.failed).toEqual([]);
      for (let i = 0; i < 100 && seen.length === 0; i++) await Bun.sleep(20);
      expect(seen).toEqual([{ activated: true, results: 20 }]);
    } finally {
      off();
    }
  });
  it("two saves of different fields of one row at the same time keep both (#1666)", async () => {
    const owner = (n: string): ExecutionContext => ({
      actorId: HUMAN,
      actorKind: "human",
      requestId: `pcfg-race-${n}`,
    });
    // Both saves change their field from what is stored, whatever earlier
    // tests left there.
    const stored = await read(MAIN);
    const results = stored.results === 33 ? 34 : 33;
    const mode = (stored.ranking as { mode: string }).mode === "hybrid" ? "words" : "hybrid";
    // A transaction holding the release row stands for a slow writer: both
    // saves start meanwhile, read the stored row and wait to write it.
    const conn = new SQL(ADMIN_URL as string);
    let release = (): void => {};
    let locked = (): void => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const [{ id: pluginId }] = (await withSystemSql(
      async (tx) => tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`,
    )) as [{ id: string }];
    const holder = conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // The tables' RLS admits only the plugin's own id.
      await tx`SELECT set_config('caelo.plugin_id', ${pluginId}, true)`;
      const held = await tx.unsafe(
        `SELECT 1 FROM "${SCHEMA}"."caelo_config" WHERE id = '${hostRowId("config:release")}' FOR UPDATE`,
      );
      if (held.length !== 1) throw new Error("the release row was not locked");
      locked();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await isLocked;
    const a = execute(registry, adapter, owner("a"), "plugin_config.update", {
      pluginSlug: SLUG,
      patch: { results },
    });
    const b = execute(registry, adapter, owner("b"), "plugin_config.update", {
      pluginSlug: SLUG,
      patch: { ranking: { mode } },
    });
    await Bun.sleep(500);
    release();
    await holder;
    await conn.end();
    for (const r of await Promise.all([a, b])) if (!r.ok) throw new Error(JSON.stringify(r.error));
    const v = await read(MAIN);
    expect(v.results).toBe(results);
    expect((v.ranking as { mode: string }).mode).toBe(mode);
  });
});
