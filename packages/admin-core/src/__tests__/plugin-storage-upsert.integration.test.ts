// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1659 — `ctx.adminQuery.upsert` keeps a key of a plugin's private
 * storage at one row, through the plugin host and the real storage
 * operations, on the shared draft, an isolated branch and main:
 *
 *   - two draft chats writing one key at the same moment leave one row:
 *     the later write meets the earlier one's row and is the usual draft
 *     conflict, which the read it names clears; both Stages leave one
 *     main row. The list-then-insert it replaces leaves two under the
 *     same timing;
 *   - rows that already share a key fold into one on the next write (the
 *     refusal international-site used to raise is gone);
 *   - rows of one key in different lines (main and a chat, two chats, two
 *     branches, however many) leave one row once staged: the Stage lands a
 *     branch's row on the key's main row, the branch's state winning;
 *   - typed keys take one spelling, `id` is never written, `keep` never
 *     overwrites, and a key no index can drive is refused.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { definePlugin, type PluginAdminQuery, type PluginInvocation } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, isUntrustedToolResult } from "@caelo-cms/shared";
import { SQL } from "bun";
import { type ToolContext, ToolRegistry } from "../ai/tools/dispatch.js";
import { getPluginDraftRowsTool } from "../ai/tools/get-plugin-draft-rows.js";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SLUG = "t-ups";
const SCHEMA = "plugin_t_ups";
const PFX = "t-ups-";
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "ups" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let tools: ToolRegistry;
let keyCounter = 0;

const q = (ctx: unknown): PluginAdminQuery => {
  const handle = (ctx as { adminQuery?: PluginAdminQuery }).adminQuery;
  if (!handle) throw new Error("adminQuery missing");
  return handle;
};

interface EntryArgs {
  readonly address: string;
  readonly value: string | null;
  readonly keep?: boolean;
}

const plugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: {
    entries: { lang: "string", address: "text", value: "text", created_at: "timestamp" },
    loose: { name: "string", value: "text" },
    typed: { page_id: "uuid", n: "int", note: "text", created_at: "timestamp" },
    // A table may declare its primary key; an upsert still never writes it.
    ided: { id: "uuid", name: "string", note: "text" },
  },
  aiReadableTables: ["entries"],
  indexes: {
    adminSchema: {
      entries: [["lang", "address"]],
      typed: [["page_id", "n"], ["created_at"]],
      ided: [["name"]],
    },
  },
  requestedCapabilities: ["cms_admin_schema", "cms_admin"],
  operations: {
    upsert: async (ctx, args) => {
      const a = args as EntryArgs;
      return q(ctx).upsert(
        "entries",
        { lang: "de", address: a.address },
        { value: a.value },
        a.keep ? { ifExists: "keep" } : undefined,
      );
    },
    /** What international-site did before #1659: read, then insert when nothing was found. */
    insert_if_missing: async (ctx, args) => {
      const a = args as EntryArgs;
      const found = await q(ctx).list("entries", { lang: "de", address: a.address, limit: 2 });
      if (found.length > 0) return { inserted: false };
      await q(ctx).insert("entries", { lang: "de", address: a.address, value: a.value });
      return { inserted: true };
    },
    insert: async (ctx, args) => {
      const a = args as EntryArgs;
      return q(ctx).insert("entries", { lang: "de", address: a.address, value: a.value });
    },
    list: async (ctx, args) =>
      q(ctx).list("entries", { lang: "de", address: (args as EntryArgs).address, limit: 100 }),
    upsert_typed: async (ctx, args) => {
      const a = args as { key: Record<string, string | number | boolean>; note: string };
      return q(ctx).upsert("typed", a.key, { note: a.note });
    },
    list_typed: async (ctx, args) =>
      q(ctx).list("typed", { page_id: (args as { pageId: string }).pageId, limit: 100 }),
    upsert_ided: async (ctx, args) => {
      const a = args as { key: Record<string, string>; values: Record<string, unknown> };
      return q(ctx).upsert("ided", a.key, a.values);
    },
    list_ided: async (ctx) => q(ctx).list("ided", { name: "a", limit: 10 }),
    upsert_unindexed: async (ctx) => q(ctx).upsert("loose", { name: "a" }, { value: "x" }),
    upsert_null_key: async (ctx) =>
      q(ctx).upsert("entries", { lang: "de", address: null as unknown as string }, {}),
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
  readonly id: string;
  readonly title: string;
  readonly ai: ExecutionContext;
  readonly invocation: PluginInvocation;
}

/** A new chat: on the site's shared draft, or on an isolated branch of its own. */
async function newChat(name: string, isolation?: "experiment"): Promise<Chat> {
  const title = `${PFX}${name}`;
  const r = await execute(registry, adapter, SYS, "chat.create_session", {
    title,
    ...(isolation ? { isolation } : {}),
  });
  if (!r.ok) throw new Error(`chat.create_session: ${JSON.stringify(r.error)}`);
  const { chatSessionId, chatBranchId, branchKind } = r.value as {
    chatSessionId: string;
    chatBranchId: string;
    branchKind: string;
  };
  expect(branchKind).toBe(isolation ? "experiment" : "draft");
  return {
    id: chatSessionId,
    title,
    ai: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `ups-${name}`,
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

async function call(invocation: PluginInvocation, operationName: string, args: unknown = {}) {
  return runPluginOperation({ pluginSlug: SLUG, operationName, args, invocation });
}

async function landed<T>(r: Awaited<ReturnType<typeof call>>): Promise<T> {
  if (!r.ok) throw new Error(`expected the write to land: ${r.error.message}`);
  return r.value as T;
}

function nextKey(): string {
  keyCounter += 1;
  return `${PFX}key-${keyCounter}`;
}

interface PhysicalRow {
  id: string;
  value: string | null;
  branch: string | null;
}

/** The live rows of a key as stored, whatever branch created them. */
async function physicalRows(address: string): Promise<PhysicalRow[]> {
  return withSystemSql(async (tx) => {
    const [p] = (await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as {
      id: string;
    }[];
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${p?.id}', true)`);
    return (await tx.unsafe(
      `SELECT id::text AS id, value, caelo_chat_branch_id::text AS branch FROM "${SCHEMA}".entries
       WHERE address = $1 AND caelo_deleted_at IS NULL ORDER BY id`,
      [address],
    )) as PhysicalRow[];
  });
}

/** The values of a key as `invocation` reads them. */
async function seen(invocation: PluginInvocation, address: string): Promise<(string | null)[]> {
  const rows = await landed<{ value: string | null }[]>(
    await call(invocation, "list", { address }),
  );
  return rows.map((r) => r.value);
}

/** The re-read a draft conflict names, as the AI makes it. */
async function readDraftRows(chat: Chat, rowIds: string[]): Promise<void> {
  const toolCtx: ToolContext = {
    adapter,
    registry,
    chatBranchId: chat.ai.chatBranchId as string,
    chatSessionId: chat.ai.chatTaskId as string,
  };
  const r = await tools.dispatch("get_plugin_draft_rows", { rowIds }, chat.ai, toolCtx);
  if (!r.ok) throw new Error(`get_plugin_draft_rows: ${r.content}`);
  expect(isUntrustedToolResult(r.content)).toBe(true);
}

/** The Stage of draft chats (the merge the Stage flow runs). */
/** The Stage of a chat on an isolated branch (its whole branch). */
async function stageIsolated(chat: Chat): Promise<void> {
  const r = await execute(registry, adapter, SYS, "chat.merge_to_main", { chatSessionId: chat.id });
  if (!r.ok) throw new Error(`chat.merge_to_main: ${JSON.stringify(r.error)}`);
}

async function stage(...chats: Chat[]): Promise<void> {
  const r = await execute(registry, adapter, SYS, "chat.merge_draft_to_main", {
    chatSessionIds: chats.map((c) => c.id),
  });
  if (!r.ok) throw new Error(`chat.merge_draft_to_main: ${JSON.stringify(r.error)}`);
}

/**
 * Run `calls` while the plugin's registry row is held: every private
 * write takes it `FOR SHARE` first, so they all wait at the same point
 * and go on together once it is released — two writers racing for one
 * key, made repeatable.
 */
async function atOnce<T>(calls: () => Promise<T>[], waiting: number): Promise<T[]> {
  const sql = new SQL(ADMIN_URL as string);
  const held = await sql.reserve();
  try {
    await held.unsafe("BEGIN");
    await held.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await held`SELECT 1 FROM plugins WHERE slug = ${SLUG} FOR UPDATE`;
    const running = calls();
    for (let i = 0; i < 500; i += 1) {
      const [row] = (await sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `) as { n: number }[];
      if ((row?.n ?? 0) >= waiting) break;
      await Bun.sleep(10);
    }
    await held.unsafe("COMMIT");
    return await Promise.all(running);
  } finally {
    held.release();
    await sql.end();
  }
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

describe("ctx.adminQuery.upsert — one row per key (#1659)", () => {
  it("the list-then-insert it replaces writes two rows when two chats write at once", async () => {
    const key = nextKey();
    const a = await newChat("race-old-a");
    const b = await newChat("race-old-b");
    const results = await atOnce(
      () => [
        call(a.invocation, "insert_if_missing", { address: key, value: "from-a" }),
        call(b.invocation, "insert_if_missing", { address: key, value: "from-b" }),
      ],
      2,
    );
    for (const r of results) await landed(r);
    // Each read found nothing, each insert went in: the race of the issue.
    expect(await physicalRows(key)).toHaveLength(2);
  });

  it("two draft chats writing one key at once leave one row; the later write is a conflict its read clears", async () => {
    const key = nextKey();
    const a = await newChat("race-a");
    const b = await newChat("race-b");
    const results = await atOnce(
      () => [
        call(a.invocation, "upsert", { address: key, value: "from-a" }),
        call(b.invocation, "upsert", { address: key, value: "from-b" }),
      ],
      2,
    );
    expect(await physicalRows(key)).toHaveLength(1);

    const [first, later] = results[0]?.ok ? [a, b] : [b, a];
    const refused = results[first === a ? 1 : 0];
    if (!refused || refused.ok) throw new Error("expected the later write to be a draft conflict");
    expect(refused.error.message).toContain("Conflict:");
    expect(refused.error.message).toContain("get_plugin_draft_rows");
    expect(refused.error.message).toContain(first.title);

    // The read the conflict names clears it, and the later write wins.
    const [row] = await physicalRows(key);
    await readDraftRows(later, [row?.id as string]);
    const laterValue = later === a ? "from-a" : "from-b";
    const written = await landed<{ id: string; created: boolean }>(
      await call(later.invocation, "upsert", { address: key, value: laterValue }),
    );
    expect(written).toEqual({ id: row?.id as string, created: false });
    expect(await seen(first.invocation, key)).toEqual([laterValue]);

    await stage(first);
    await stage(later);
    const live = await physicalRows(key);
    expect(live).toEqual([{ id: row?.id as string, value: laterValue, branch: null }]);
    expect(await seen(MAIN, key)).toEqual([laterValue]);
  });

  it("folds rows that already share the key: the write that used to refuse goes through", async () => {
    const key = nextKey();
    await landed(await call(MAIN, "insert", { address: key, value: "old-1" }));
    await landed(await call(MAIN, "insert", { address: key, value: "old-2" }));
    expect(await physicalRows(key)).toHaveLength(2);

    const a = await newChat("fold-a");
    const written = await landed<{ id: string; created: boolean }>(
      await call(a.invocation, "upsert", { address: key, value: "fixed" }),
    );
    expect(written.created).toBe(false);
    expect(await seen(a.invocation, key)).toEqual(["fixed"]);
    // Main is untouched until the Stage, which leaves one row.
    expect((await seen(MAIN, key)).sort()).toEqual(["old-1", "old-2"]);
    await stage(a);
    expect(await physicalRows(key)).toEqual([{ id: written.id, value: "fixed", branch: null }]);
  });

  it("folds on the main line too", async () => {
    const key = nextKey();
    await landed(await call(MAIN, "insert", { address: key, value: "old-1" }));
    await landed(await call(MAIN, "insert", { address: key, value: "old-2" }));
    await landed(await call(MAIN, "upsert", { address: key, value: "fixed" }));
    expect((await physicalRows(key)).map((r) => r.value)).toEqual(["fixed"]);
  });

  it("a main-line placeholder beside a chat's unstaged row: the chat's value lands on it at the Stage", async () => {
    const key = nextKey();
    const a = await newChat("adopt-a");
    const mine = await landed<{ id: string; created: boolean }>(
      await call(a.invocation, "upsert", { address: key, value: "translated" }),
    );
    expect(mine.created).toBe(true);

    // The change consumer runs on main and cannot see the chat's row.
    const placeholder = await landed<{ id: string; created: boolean }>(
      await call(MAIN, "upsert", { address: key, value: null, keep: true }),
    );
    expect(placeholder.created).toBe(true);
    expect(await seen(MAIN, key)).toEqual([null]);

    await stage(a);
    expect(await physicalRows(key)).toEqual([
      { id: placeholder.id, value: "translated", branch: null },
    ]);
  });

  it("two branches each holding a row of the key leave one row after both Stages", async () => {
    const key = nextKey();
    const x = await newChat("other-x", "experiment");
    await landed(await call(x.invocation, "upsert", { address: key, value: "from-x" }));
    const a = await newChat("other-a");
    const mine = await landed<{ id: string; created: boolean }>(
      await call(a.invocation, "upsert", { address: key, value: "from-a" }),
    );
    // Neither line sees the other's row; each holds one.
    expect(mine.created).toBe(true);
    expect(await seen(x.invocation, key)).toEqual(["from-x"]);
    expect(await seen(a.invocation, key)).toEqual(["from-a"]);

    await stage(a);
    const afterFirst = await physicalRows(key);
    expect(afterFirst.filter((r) => r.branch === null)).toEqual([
      { id: mine.id, value: "from-a", branch: null },
    ]);
    expect(afterFirst.filter((r) => r.branch !== null).map((r) => r.value)).toEqual(["from-x"]);
    // The later Stage lands on the key's main row and drops its own.
    await stageIsolated(x);
    expect(await physicalRows(key)).toEqual([{ id: mine.id, value: "from-x", branch: null }]);
  });

  it("a main-line write with two unstaged duplicates on two branches leaves one row after the Stages", async () => {
    // What writers left before #1659: two chats each inserted a row of the
    // key, neither staged.
    const key = nextKey();
    const x = await newChat("dup-x", "experiment");
    const y = await newChat("dup-y", "experiment");
    await landed(await call(x.invocation, "insert", { address: key, value: "from-x" }));
    await landed(await call(y.invocation, "insert", { address: key, value: "from-y" }));

    const main = await landed<{ id: string; created: boolean }>(
      await call(MAIN, "upsert", { address: key, value: "main" }),
    );
    expect(main.created).toBe(true);
    expect(await physicalRows(key)).toHaveLength(3);

    await stageIsolated(x);
    expect((await physicalRows(key)).filter((r) => r.branch === null)).toEqual([
      { id: main.id, value: "from-x", branch: null },
    ]);
    await stageIsolated(y);
    expect(await physicalRows(key)).toEqual([{ id: main.id, value: "from-y", branch: null }]);
  });

  it("two unstaged duplicates in the shared draft fold into the key's main row at one Stage", async () => {
    const key = nextKey();
    const a = await newChat("dup-a");
    const b = await newChat("dup-b");
    await landed(await call(a.invocation, "insert", { address: key, value: "from-a" }));
    await landed(await call(b.invocation, "insert", { address: key, value: "from-b" }));
    const main = await landed<{ id: string }>(
      await call(MAIN, "upsert", { address: key, value: "main" }),
    );

    // A draft Stage takes every pending plugin row of the draft (they can
    // shape URLs): both land on the main row, and one row is left.
    await stage(a);
    const rows = await physicalRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: main.id, branch: null });
    expect(["from-a", "from-b"]).toContain(rows[0]?.value as string);
  });

  it("a main-line write of a key with a main row and a chat's unstaged row leaves one row after the Stage", async () => {
    const key = nextKey();
    const existing = await landed<{ id: string }>(
      await call(MAIN, "insert", { address: key, value: "main" }),
    );
    const a = await newChat("legacy-main-a");
    await landed(await call(a.invocation, "insert", { address: key, value: "from-a" }));

    const written = await landed<{ id: string; created: boolean }>(
      await call(MAIN, "upsert", { address: key, value: "fixed" }),
    );
    expect(written).toEqual({ id: existing.id, created: false });
    expect(await seen(MAIN, key)).toEqual(["fixed"]);

    await stage(a);
    expect(await physicalRows(key)).toEqual([{ id: existing.id, value: "from-a", branch: null }]);
  });

  it("a chat's write of a key with a main row and another branch's unstaged row leaves one row", async () => {
    const key = nextKey();
    await landed(await call(MAIN, "insert", { address: key, value: "main" }));
    const x = await newChat("legacy-other-x", "experiment");
    await landed(await call(x.invocation, "insert", { address: key, value: "from-x" }));

    const a = await newChat("legacy-other-a");
    await landed(await call(a.invocation, "upsert", { address: key, value: "from-a" }));
    expect(await seen(a.invocation, key)).toEqual(["from-a"]);

    await stage(a);
    await stageIsolated(x);
    expect((await physicalRows(key)).map((r) => [r.value, r.branch])).toEqual([["from-x", null]]);
  });

  it("never writes id: a key or values naming it are refused, naming the fix", async () => {
    const id = crypto.randomUUID();
    const stored = await landed<{ id: string }>(
      await call(MAIN, "upsert_ided", { key: { name: "a" }, values: { note: "first" } }),
    );
    for (const args of [
      { key: { name: "a" }, values: { id, note: "moved" } },
      { key: { id }, values: { note: "x" } },
    ]) {
      const r = await call(MAIN, "upsert_ided", args);
      if (r.ok) throw new Error(`expected ${JSON.stringify(args)} to be refused`);
      expect(r.error.message).toContain(
        '"id" is the row\'s primary key, which an upsert never writes',
      );
    }
    const rows = await landed<{ id: string; note: string }[]>(await call(MAIN, "list_ided"));
    expect(rows).toEqual([expect.objectContaining({ id: stored.id, note: "first" })]);
  });

  it("takes a typed key in its column's spelling only, so equal keys name one row", async () => {
    const pageId = crypto.randomUUID();
    const first = await landed<{ id: string; created: boolean }>(
      await call(MAIN, "upsert_typed", { key: { page_id: pageId.toUpperCase(), n: 1 }, note: "a" }),
    );
    const again = await landed<{ id: string; created: boolean }>(
      await call(MAIN, "upsert_typed", { key: { page_id: pageId, n: 1 }, note: "b" }),
    );
    expect(again).toEqual({ id: first.id, created: false });
    const rows = await landed<{ note: string }[]>(await call(MAIN, "list_typed", { pageId }));
    expect(rows.map((r) => r.note)).toEqual(["b"]);

    for (const [key, message] of [
      [{ page_id: pageId, n: "1" }, "the int column takes an integer as a key"],
      [{ page_id: "not-a-uuid", n: 1 }, "the uuid column takes a uuid string as a key"],
      [
        { created_at: "2026-11-24T00:00:00Z" },
        'the timestamp column "created_at" cannot be part of a key',
      ],
    ] as const) {
      const r = await call(MAIN, "upsert_typed", { key, note: "x" });
      if (r.ok) throw new Error(`expected ${JSON.stringify(key)} to be refused`);
      expect(r.error.message).toContain(message);
    }
  });

  it("keep leaves an existing row as it is", async () => {
    const key = nextKey();
    const stored = await landed<{ id: string }>(
      await call(MAIN, "upsert", { address: key, value: "real" }),
    );
    const kept = await landed<{ id: string; created: boolean }>(
      await call(MAIN, "upsert", { address: key, value: null, keep: true }),
    );
    expect(kept).toEqual({ id: stored.id, created: false });
    expect(await seen(MAIN, key)).toEqual(["real"]);
  });

  it("refuses a key no index can drive, and a key without a value", async () => {
    const unindexed = await call(MAIN, "upsert_unindexed");
    if (unindexed.ok) throw new Error("expected the unindexed key to be refused");
    expect(unindexed.error.message).toContain("no index covers this read");
    expect(unindexed.error.message).toContain('"loose"');

    const nullKey = await call(MAIN, "upsert_null_key");
    if (nullKey.ok) throw new Error("expected the null key to be refused");
    expect(nullKey.error.message).toContain("is null — the text column takes a string as a key");
  });
});
