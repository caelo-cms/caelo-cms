// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1387 — a draft conflict on a plugin's private row clears with the
 * read it names.
 *
 * A plugin's private-storage write refuses through `OperationAbortError`
 * (storage-ops.ts `settle`), so the observation the conflict records rolls
 * back, and no plugin read recorded one: the chat conflicted on that row
 * on every retry. Pinned here, through the plugin host and the tool
 * dispatcher, on the shared draft:
 *
 *   - the conflict names `get_plugin_draft_rows` with the row's id;
 *   - resending without that read still conflicts;
 *   - that read shows the other chat's change, and the redone write lands;
 *   - a preview render of the same rows clears nothing (it is not the AI
 *     looking at them), nor does another chat's read or a write tool's own
 *     read;
 *   - a change made after the read is a conflict again, so parallel chats
 *     never overwrite each other silently;
 *   - the read shows only rows with a pending change, only columns the
 *     plugin still declares, and no values of a table the plugin did not
 *     list in `aiReadableTables`; such a read still clears the conflict.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  loadedPlugins,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import {
  definePlugin,
  manifestFromDefinition,
  type PluginAdminQuery,
  type PluginInvocation,
  pluginManifest,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  isUntrustedToolResult,
  untrustedToolResultValue,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { type ToolContext, ToolRegistry } from "../ai/tools/dispatch.js";
import { getPluginDraftRowsTool } from "../ai/tools/get-plugin-draft-rows.js";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SLUG = "t-pdc";
const SCHEMA = "plugin_t_pdc";
const PFX = "t-pdc-";
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "pdc" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let tools: ToolRegistry;
/** Numbers each seeded row: every test fights over rows of its own. */
let seedCounter = 0;

const q = (ctx: unknown): PluginAdminQuery => {
  const handle = (ctx as { adminQuery?: PluginAdminQuery }).adminQuery;
  if (!handle) throw new Error("adminQuery missing");
  return handle;
};

const plugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { notes: { label: "string" }, recipients: { email: "string" } },
  aiReadableTables: ["notes"],
  indexes: { adminSchema: { notes: [["label"]] } },
  requestedCapabilities: ["cms_admin_schema", "cms_admin"],
  operations: {
    seed: async (ctx, args) => q(ctx).insert("notes", { label: (args as { label: string }).label }),
    rename: async (ctx, args) => {
      const a = args as { id: string; label: string };
      await q(ctx).update("notes", a.id, { label: a.label });
      return {};
    },
    seed_recipient: async (ctx, args) =>
      q(ctx).insert("recipients", { email: (args as { email: string }).email }),
    set_recipient: async (ctx, args) => {
      const a = args as { id: string; email: string };
      await q(ctx).update("recipients", a.id, { email: a.email });
      return {};
    },
    remove: async (ctx, args) => {
      await q(ctx).delete("notes", (args as { id: string }).id);
      return {};
    },
    swap: async (ctx, args) => {
      const a = args as { id: string; from: string; to: string };
      return q(ctx).compareAndSwap("notes", a.id, { label: a.from }, { label: a.to });
    },
    /** A write tool's own read: it reads the rows, then writes. */
    rename_after_read: async (ctx, args) => {
      const a = args as { id: string; label: string };
      await q(ctx).list("notes", { orderBy: "label", orderDir: "asc" });
      await q(ctx).update("notes", a.id, { label: a.label });
      return {};
    },
    list: async (ctx) => q(ctx).list("notes", { orderBy: "label", orderDir: "asc" }),
  },
});

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
  readonly title: string;
  readonly ai: ExecutionContext;
  readonly invocation: PluginInvocation;
}

/** A new chat on the site's shared draft, as the AI acting in it. */
async function draftChat(name: string): Promise<Chat> {
  const title = `${PFX}${name}`;
  const r = await execute(registry, adapter, SYS, "chat.create_session", { title });
  if (!r.ok) throw new Error(`chat.create_session: ${JSON.stringify(r.error)}`);
  const { chatSessionId, chatBranchId, branchKind } = r.value as {
    chatSessionId: string;
    chatBranchId: string;
    branchKind: string;
  };
  expect(branchKind).toBe("draft");
  return {
    title,
    ai: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `pdc-${name}`,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
    invocation: {
      origin: "chat",
      actorId: HUMAN,
      operatorActorId: HUMAN,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
  };
}

const MAIN: PluginInvocation = { origin: "system", actorId: HUMAN };

async function call(invocation: PluginInvocation, operationName: string, args: unknown) {
  return runPluginOperation({ pluginSlug: SLUG, operationName, args, invocation });
}

/** A row on main that no chat has touched yet. */
async function seedRow(): Promise<string> {
  seedCounter += 1;
  const r = await call(MAIN, "seed", { label: `seed-${seedCounter}` });
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { id: string }).id;
}

async function rename(chat: Chat, id: string, label: string) {
  return call(chat.invocation, "rename", { id, label });
}

/** The error message of a plugin call that must be refused as a draft conflict. */
function conflictOf(r: Awaited<ReturnType<typeof call>>): string {
  if (r.ok) throw new Error("expected a draft conflict, but the write went through");
  expect(r.error.message).toContain("Conflict:");
  return r.error.message;
}

function landed(r: Awaited<ReturnType<typeof call>>): void {
  if (!r.ok) throw new Error(`expected the write to land: ${r.error.message}`);
}

interface ShownRow {
  id: string;
  plugin: string;
  table: string;
  deleted: boolean;
  values: Record<string, unknown> | null;
  changedByChat: string;
}

/** The re-read the conflict names, as the AI makes it (through the dispatcher). */
async function readRows(chat: Chat, rowIds: string[]) {
  const toolCtx: ToolContext = {
    adapter,
    registry,
    chatBranchId: chat.ai.chatBranchId as string,
    chatSessionId: chat.ai.chatTaskId as string,
  };
  const r = await tools.dispatch("get_plugin_draft_rows", { rowIds }, chat.ai, toolCtx);
  if (!r.ok) throw new Error(`get_plugin_draft_rows: ${r.content}`);
  expect(r.content).not.toContain("could not be recorded");
  // Plugin data may come from visitors: it reaches the AI marked as data (#635).
  expect(isUntrustedToolResult(r.content)).toBe(true);
  return untrustedToolResultValue(r.content) as { rows: ShownRow[]; noPendingChange: string[] };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  tools = new ToolRegistry();
  tools.register(getPluginDraftRowsTool);
  await wipe();
  const infra: PluginHostInfra = { adapter, registry, lockPluginRow };
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: HUMAN,
    testPlugins: [{ definition: plugin }],
  });
  expect(report.failed).toEqual([]);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("draft conflict on a plugin row (#1387)", () => {
  it("a retry without a read conflicts; the named read clears it; the redone write lands", async () => {
    const id = await seedRow();
    const a = await draftChat("clear-a");
    const b = await draftChat("clear-b");
    landed(await rename(a, id, "from-a"));

    const first = conflictOf(await rename(b, id, "from-b"));
    expect(first).toContain(`get_plugin_draft_rows({rowIds:["${id}"]})`);
    expect(first).toContain("counts as having seen the change");
    expect(first).toContain(a.title);

    // The refused write's observation rolled back, and it must stay that
    // way: telling the AI is not the AI having read it.
    conflictOf(await rename(b, id, "from-b"));

    const seen = await readRows(b, [id]);
    expect(seen.noPendingChange).toEqual([]);
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0]).toMatchObject({
      id,
      plugin: SLUG,
      table: "notes",
      deleted: false,
      changedByChat: a.title,
    });
    expect(seen.rows[0]?.values.label).toBe("from-a");

    landed(await rename(b, id, "from-a and from-b"));
    const view = await call(b.invocation, "list", {});
    if (!view.ok) throw new Error(view.error.message);
    expect((view.value as { label: string }[]).map((n) => n.label)).toContain("from-a and from-b");
  });

  it("clears delete and compare-and-swap conflicts the same way", async () => {
    const a = await draftChat("verbs-a");
    const b = await draftChat("verbs-b");

    const swapRow = await seedRow();
    landed(await rename(a, swapRow, "a-swap"));
    conflictOf(await call(b.invocation, "swap", { id: swapRow, from: "a-swap", to: "b-swap" }));
    await readRows(b, [swapRow]);
    const swapped = await call(b.invocation, "swap", { id: swapRow, from: "a-swap", to: "b-swap" });
    expect(swapped).toMatchObject({ ok: true, value: true });

    const removeRow = await seedRow();
    landed(await rename(a, removeRow, "a-remove"));
    conflictOf(await call(b.invocation, "remove", { id: removeRow }));
    await readRows(b, [removeRow]);
    landed(await call(b.invocation, "remove", { id: removeRow }));
  });

  it("reports a pending delete as deleted", async () => {
    const id = await seedRow();
    const a = await draftChat("deleted-a");
    const b = await draftChat("deleted-b");
    landed(await call(a.invocation, "remove", { id }));
    const seen = await readRows(b, [id]);
    expect(seen.rows[0]?.deleted).toBe(true);
  });

  it("a change made after the read is a conflict again: nothing is overwritten silently", async () => {
    const id = await seedRow();
    const a = await draftChat("again-a");
    const b = await draftChat("again-b");
    landed(await rename(a, id, "a-1"));
    await readRows(b, [id]);

    // Chat A writes again after B's read: B's read does not cover it.
    landed(await rename(a, id, "a-2"));
    const stale = conflictOf(await rename(b, id, "b-on-a-1"));
    expect(stale).toContain(a.title);

    await readRows(b, [id]);
    landed(await rename(b, id, "b-on-a-2"));

    // And the other way round: A must now read B's change before it writes.
    conflictOf(await rename(a, id, "a-3"));
  });

  it("only the chat that read it is cleared", async () => {
    const id = await seedRow();
    const a = await draftChat("other-a");
    const b = await draftChat("other-b");
    const c = await draftChat("other-c");
    landed(await rename(a, id, "from-a"));
    await readRows(c, [id]);
    conflictOf(await rename(b, id, "from-b"));
  });

  it("a preview render of the rows clears nothing", async () => {
    const id = await seedRow();
    const a = await draftChat("render-a");
    const b = await draftChat("render-b");
    landed(await rename(a, id, "from-a"));

    // What a chat's preview does: the same rows through the same storage
    // op, on the chat's branch. The AI has not seen them.
    const render: PluginInvocation = {
      origin: "render",
      actorId: HUMAN,
      chatBranchId: b.ai.chatBranchId as string,
      chatTaskId: b.ai.chatTaskId as string,
    };
    const preview = await call(render, "list", {});
    if (!preview.ok) throw new Error(preview.error.message);
    expect((preview.value as { label: string }[]).map((n) => n.label)).toContain("from-a");

    conflictOf(await rename(b, id, "from-b"));
  });

  it("a write tool's own read of the rows clears nothing", async () => {
    const id = await seedRow();
    const a = await draftChat("internal-a");
    const b = await draftChat("internal-b");
    landed(await rename(a, id, "from-a"));
    const args = { id, label: "from-b" };
    conflictOf(await call(b.invocation, "rename_after_read", args));
    conflictOf(await call(b.invocation, "rename_after_read", args));
  });

  it("names rows without a pending change instead of showing main-line data", async () => {
    const untouched = await seedRow();
    const pending = await seedRow();
    const a = await draftChat("scope-a");
    const b = await draftChat("scope-b");
    landed(await rename(a, pending, "from-a"));

    const seen = await readRows(b, [untouched, pending]);
    expect(seen.rows.map((r) => r.id)).toEqual([pending]);
    expect(seen.noPendingChange).toEqual([untouched]);
  });

  it("shows no column the plugin no longer declares", async () => {
    const id = await seedRow();
    const a = await draftChat("columns-a");
    const b = await draftChat("columns-b");
    landed(await rename(a, id, "from-a"));

    // A column dropped from the spec stays in the old snapshot's JSON. The
    // plugin's own reads never return it (privateReadColumns), nor may this.
    await withSystemSql(async (tx) => {
      await tx`
        UPDATE plugin_row_snapshots
        SET state = jsonb_set(state, '{values,dropped_column}', '"x"'::jsonb)
        WHERE row_id = ${id}::uuid
      `;
    });
    const seen = await readRows(b, [id]);
    expect(seen.rows[0]?.values.label).toBe("from-a");
    expect(seen.rows[0]?.values).not.toHaveProperty("dropped_column");
  });

  it("keeps a table the plugin did not list from the AI, and still clears the conflict", async () => {
    const seeded = await call(MAIN, "seed_recipient", { email: "old@example.com" });
    if (!seeded.ok) throw new Error(seeded.error.message);
    const id = (seeded.value as { id: string }).id;
    const a = await draftChat("hidden-a");
    const b = await draftChat("hidden-b");
    landed(await call(a.invocation, "set_recipient", { id, email: "secret@example.com" }));

    const args = { id, email: "b@example.com" };
    conflictOf(await call(b.invocation, "set_recipient", args));
    const seen = await readRows(b, [id]);
    expect(seen.rows[0]).toMatchObject({ id, table: "recipients", changedByChat: a.title });
    expect(seen.rows[0]?.values).toBeNull();
    expect(JSON.stringify(seen)).not.toContain("secret@example.com");
    landed(await call(b.invocation, "set_recipient", args));
  });

  it("refuses a manifest whose aiReadableTables names an undeclared table", () => {
    const r = pluginManifest.safeParse({
      ...manifestFromDefinition(plugin),
      aiReadableTables: ["nope"],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("adminSchema does not declare");
  });

  it("shows nothing of a plugin that is not running, and clears nothing", async () => {
    const id = await seedRow();
    const a = await draftChat("stopped-a");
    const b = await draftChat("stopped-b");
    landed(await rename(a, id, "from-a"));

    const running = loadedPlugins.bySlug(SLUG);
    if (!running) throw new Error("test plugin not loaded");
    loadedPlugins.unload(SLUG);
    try {
      const seen = await readRows(b, [id]);
      expect(seen.rows).toEqual([]);
      expect(seen.noPendingChange).toEqual([id]);
    } finally {
      loadedPlugins.set(running);
    }
    conflictOf(await rename(b, id, "from-b"));
  });

  it("refuses outside a chat, naming why", async () => {
    const r = await execute(registry, adapter, SYS, "plugins.get_draft_rows", {
      rowIds: [crypto.randomUUID()],
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("inside a chat");
  });
});
