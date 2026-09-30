// SPDX-License-Identifier: MPL-2.0

/**
 * Branch-aware plugin storage (docs/branch-aware-plugin-storage.md,
 * CMS_REQUIREMENTS §14.7): a plugin's private rows follow the same
 * branch model as core content. Pinned here, end to end through the
 * plugin host and the chat ops:
 *
 * - `onActivate` seeds on main before anything reads;
 * - a chat's writes stay on its branch (live rows untouched, overlay
 *   visible only to that chat) and lock the rows they touch;
 * - Stage merges the branch state live and snapshots it on main;
 * - `chat.discard_branch` drops what the branch created, and a
 *   discarded chat can never be merged;
 * - render calls cannot write private storage;
 * - `ctx.cms.call` from a chat writes core entities on the chat's branch.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import {
  definePlugin,
  type PluginAdminQuery,
  type PluginCms,
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

const SLUG = "t-pbs";
const SCHEMA = "plugin_t_pbs";
const PFX = "t-pbs-";
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const AI = "00000000-0000-0000-0000-000000000a1a";
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const humanCtx: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "pbs" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

type Ctx = { adminQuery?: PluginAdminQuery; cms?: PluginCms };
const q = (ctx: unknown): PluginAdminQuery => {
  const handle = (ctx as Ctx).adminQuery;
  if (!handle) throw new Error("adminQuery missing");
  return handle;
};

const plugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { notes: { label: "string" } },
  requestedCapabilities: ["cms_admin_schema", "cms_admin"],
  onActivate: async (ctx) => {
    const existing = await q(ctx).list("notes", { limit: 1 });
    if (existing.length === 0) await q(ctx).insert("notes", { label: "seed" });
  },
  operations: {
    add: async (ctx, args) => q(ctx).insert("notes", { label: (args as { label: string }).label }),
    rename: async (ctx, args) => {
      const a = args as { id: string; label: string };
      await q(ctx).update("notes", a.id, { label: a.label });
      return {};
    },
    remove: async (ctx, args) => {
      await q(ctx).delete("notes", (args as { id: string }).id);
      return {};
    },
    list: async (ctx) => q(ctx).list("notes", { orderBy: "label", orderDir: "asc" }),
    retitle_page: async (ctx, args) => {
      const cms = (ctx as Ctx).cms;
      if (!cms) throw new Error("cms missing");
      const a = args as { pageId: string; title: string };
      await cms.call("pages.update", { pageId: a.pageId, title: a.title });
      return {};
    },
  },
});

async function withSystemSql<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
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
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
  });
}

/** Live rows, host columns included, read inside the plugin's RLS scope. */
async function liveRows(): Promise<
  { id: string; label: string; caelo_deleted_at: unknown; caelo_chat_branch_id: string | null }[]
> {
  return withSystemSql(async (tx) => {
    const [p] = (await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as {
      id: string;
    }[];
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${p?.id}', true)`);
    return (await tx.unsafe(
      `SELECT id::text AS id, label, caelo_deleted_at, caelo_chat_branch_id::text AS caelo_chat_branch_id FROM "${SCHEMA}".notes ORDER BY label`,
    )) as never;
  });
}

interface Chat {
  readonly chatSessionId: string;
  readonly chatBranchId: string;
  readonly invocation: PluginInvocation;
}

async function newChat(title: string): Promise<Chat> {
  const r = await execute(registry, adapter, humanCtx, "chat.create_session", {
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
  };
}

const MAIN: PluginInvocation = { origin: "owner-panel", actorId: HUMAN };

async function call(invocation: PluginInvocation, operationName: string, args: unknown = {}) {
  return runPluginOperation({ pluginSlug: SLUG, operationName, args, invocation });
}

async function labels(invocation: PluginInvocation): Promise<string[]> {
  const r = await call(invocation, "list");
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { label: string }[]).map((n) => n.label);
}

function idOf(value: unknown): string {
  return (value as { id: string }).id;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const infra: PluginHostInfra = { adapter, registry, lockPluginRow };
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: plugin }],
  });
  expect(report.failed).toEqual([]);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("branch-aware plugin storage", () => {
  let seedId = "";

  it("onActivate seeds on main before anything reads", async () => {
    expect(await labels(MAIN)).toEqual(["seed"]);
    const [seed] = await liveRows();
    expect(seed?.caelo_chat_branch_id).toBeNull();
    seedId = seed?.id ?? "";
  });

  it("keeps a chat's writes on its branch and locks the rows it touches", async () => {
    const a = await newChat("a");
    const added = await call(a.invocation, "add", { label: "a-new" });
    if (!added.ok) throw new Error(added.error.message);
    expect((await call(a.invocation, "rename", { id: seedId, label: "seed-a" })).ok).toBe(true);

    // The chat sees its own state; main and the live rows do not.
    expect(await labels(a.invocation)).toEqual(["a-new", "seed-a"]);
    expect(await labels(MAIN)).toEqual(["seed"]);
    const live = await liveRows();
    expect(live.find((r) => r.id === seedId)?.label).toBe("seed");
    expect(live.find((r) => r.id === idOf(added.value))?.caelo_chat_branch_id).toBe(a.chatBranchId);

    // Another chat cannot diverge on a row the first one holds.
    const b = await newChat("b");
    const blocked = await call(b.invocation, "rename", { id: seedId, label: "seed-b" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toContain("busy in another chat");

    // Pending changes and the change counter list both rows.
    const pending = await execute(registry, adapter, humanCtx, "chat.list_pending_changes", {
      chatSessionId: a.chatSessionId,
    });
    if (!pending.ok) throw new Error("pending");
    const globals = (pending.value as { pending: { globals: { kind: string; label: string }[] } })
      .pending.globals;
    expect(globals.filter((g) => g.kind === "pluginRow").map((g) => g.label)).toEqual([
      `${SLUG} · notes`,
      `${SLUG} · notes`,
    ]);
    const count = await execute(registry, adapter, humanCtx, "chat.branch_change_count", {
      chatSessionId: a.chatSessionId,
    });
    if (!count.ok) throw new Error("count");
    expect((count.value as { byKind: { pluginRows: number } }).byKind.pluginRows).toBe(2);

    // Stage merges the branch state live.
    const merged = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId: a.chatSessionId,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await labels(MAIN)).toEqual(["a-new", "seed-a"]);
    for (const row of await liveRows()) expect(row.caelo_chat_branch_id).toBeNull();

    // The merge left main-line snapshots for undo after publish.
    const mainCopies = await withSystemSql(
      async (tx) =>
        (await tx`
          SELECT count(*)::int AS n FROM plugin_row_snapshots prs
          JOIN site_snapshots ss ON ss.id = prs.site_snapshot_id
          WHERE ss.op_kind = 'chat.merge_to_main' AND ss.chat_branch_id IS NULL
            AND prs.schema_name = ${SCHEMA}
        `) as { n: number }[],
    );
    expect(mainCopies[0]?.n).toBe(2);

    // Stage released the lock: the other chat may now edit the row.
    expect((await call(b.invocation, "rename", { id: seedId, label: "seed-b" })).ok).toBe(true);
  });

  it("discards a chat's branch state and never merges a discarded chat", async () => {
    const c = await newChat("c");
    const added = await call(c.invocation, "add", { label: "c-new" });
    if (!added.ok) throw new Error(added.error.message);
    const aNew = (await liveRows()).find((r) => r.label === "a-new");
    expect((await call(c.invocation, "remove", { id: aNew?.id })).ok).toBe(true);
    expect(await labels(c.invocation)).toEqual(["c-new", "seed-a"]);

    const discarded = await execute(registry, adapter, humanCtx, "chat.discard_branch", {
      chatSessionId: c.chatSessionId,
    });
    if (!discarded.ok) throw new Error(JSON.stringify(discarded.error));
    expect((discarded.value as { droppedRows: number }).droppedRows).toBe(1);

    const live = await liveRows();
    expect(live.find((r) => r.label === "c-new")?.caelo_deleted_at).not.toBeNull();
    expect(live.find((r) => r.label === "a-new")?.caelo_deleted_at).toBeNull();
    expect(await labels(MAIN)).toEqual(["a-new", "seed-a"]);

    const publish = await execute(registry, adapter, humanCtx, "chat.publish", {
      chatSessionId: c.chatSessionId,
    });
    expect(publish.ok).toBe(false);
    if (!publish.ok) expect(JSON.stringify(publish.error)).toContain("discarded");
  });

  it("refuses private-storage writes from a render call", async () => {
    const r = await call({ origin: "render", actorId: SYSTEM_ACTOR_ID }, "add", { label: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.message).toContain("cannot write its private storage from a render call");
  });

  it("writes core entities from a chat on the chat's branch", async () => {
    const t = await execute(registry, adapter, humanCtx, "templates.create", {
      slug: `${PFX}t`,
      displayName: "T",
      html: '<caelo-slot name="content"></caelo-slot>',
      css: "",
    });
    if (!t.ok) throw new Error("seed template");
    const p = await execute(registry, adapter, humanCtx, "pages.create", {
      slug: `${PFX}p`,
      title: "Before",
      templateId: (t.value as { templateId: string }).templateId,
    });
    if (!p.ok) throw new Error("seed page");
    const pageId = (p.value as { pageId: string }).pageId;

    const d = await newChat("d");
    const r = await call(d.invocation, "retitle_page", { pageId, title: "After" });
    if (!r.ok) throw new Error(r.error.message);

    const rows = await withSystemSql(
      async (tx) =>
        (await tx`
          SELECT p.title,
                 (SELECT count(*)::int FROM page_snapshots ps
                    JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
                   WHERE ps.page_id = p.id AND ss.chat_branch_id = ${d.chatBranchId}::uuid) AS branched
          FROM pages p WHERE p.id = ${pageId}::uuid
        `) as { title: string; branched: number }[],
    );
    expect(rows[0]?.title).toBe("Before");
    expect(rows[0]?.branched).toBeGreaterThan(0);
  });
});
