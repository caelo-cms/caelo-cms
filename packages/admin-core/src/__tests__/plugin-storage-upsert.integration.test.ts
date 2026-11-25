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
 *   - a Stage locks the keys it lands, or their table when it lands many,
 *     so a racing upsert waits for it and a big Stage holds few locks;
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
  STAGE_KEY_LOCKS_PER_TABLE,
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
    update: async (ctx, args) => {
      const a = args as { id: string; value: string };
      await q(ctx).update("entries", a.id, { value: a.value });
      return { updated: true };
    },
    /** An upsert of the same table by another key (`lang` alone leads its index too). */
    upsert_lang_only: async (ctx) => q(ctx).upsert("entries", { lang: "zz" }, { value: "x" }),
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

/**
 * A key's live rows without their ids: which row is the key's row follows
 * from the ids (the smallest), which are random here.
 */
async function liveRows(
  address: string,
): Promise<{ value: string | null; branch: string | null }[]> {
  return (await physicalRows(address)).map((r) => ({ value: r.value, branch: r.branch }));
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

/** The Stage of a chat on an isolated branch (its whole branch). */
async function stageIsolated(chat: Chat): Promise<void> {
  const r = await execute(registry, adapter, SYS, "chat.merge_to_main", { chatSessionId: chat.id });
  if (!r.ok) throw new Error(`chat.merge_to_main: ${JSON.stringify(r.error)}`);
}

/**
 * The Stage of draft chats (the merge the Stage flow runs). With
 * `deferConsume` the merge leaves the chats' changes pending, as the Stage
 * flow does until its build succeeded: a failed build stages them again.
 */
async function stage(...chats: Chat[]): Promise<void> {
  await mergeDraft(chats, false);
}

async function mergeDraft(chats: readonly Chat[], deferConsume: boolean): Promise<void> {
  const r = await execute(registry, adapter, SYS, "chat.merge_draft_to_main", {
    chatSessionIds: chats.map((c) => c.id),
    ...(deferConsume ? { deferConsume } : {}),
  });
  if (!r.ok) throw new Error(`chat.merge_draft_to_main: ${JSON.stringify(r.error)}`);
}

/** The key the host recorded for one of the plugin's tables, its columns sorted. */
async function recordedKeyOf(table: string): Promise<string[] | null> {
  return withSystemSql(async (tx) => {
    const [row] = (await tx`
      SELECT k.key_columns AS key FROM plugin_storage_keys k
      JOIN plugins p ON p.id = k.plugin_id
      WHERE p.slug = ${SLUG} AND k.table_name = ${table}
    `) as { key: string[] }[];
    return row?.key ?? null;
  });
}

/** A main-line row of the entries table with a chosen id (ids decide the key's row). */
async function insertMainRow(id: string, address: string, value: string | null): Promise<void> {
  await withSystemSql(async (tx) => {
    const [p] = (await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as {
      id: string;
    }[];
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${p?.id}', true)`);
    await tx.unsafe(
      `INSERT INTO "${SCHEMA}".entries (id, lang, address, value) VALUES ($1::uuid, 'de', $2, $3)`,
      [id, address, value],
    );
  });
}

/** Holds the plugin's registry row: every private write takes it `FOR SHARE` first. */
const holdPluginRow = (tx: Bun.SQL) =>
  tx`SELECT 1 FROM plugins WHERE slug = ${SLUG} FOR UPDATE` as Promise<unknown>;

/**
 * Holds plugin_row_snapshots against inserts: every plugin row write — an
 * upsert's, a merge's — records its snapshot there after it wrote the row,
 * so each waits holding what it has read and written so far.
 */
const holdRowSnapshots = (tx: Bun.SQL) =>
  tx.unsafe("LOCK TABLE plugin_row_snapshots IN SHARE MODE") as Promise<unknown>;

/**
 * Run `calls` while `hold` keeps them waiting at the same point; they go
 * on together once it is released — writers racing for one key, made
 * repeatable.
 */
async function atOnce<T>(
  calls: () => Promise<T>[],
  waiting: number,
  hold: (tx: Bun.SQL) => Promise<unknown> = holdPluginRow,
): Promise<T[]> {
  const sql = new SQL(ADMIN_URL as string);
  const held = await sql.reserve();
  try {
    await held.unsafe("BEGIN");
    await held.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await hold(held as unknown as Bun.SQL);
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

/** Backends of this database waiting on a lock, by what they wait on. */
async function lockWaits(sql: Bun.SQL): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT wait_event AS event, count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
    GROUP BY wait_event
  `) as { event: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.event, r.n]));
}

/** Wait until `n` backends wait on a lock, and say on what; fail loudly if they never do. */
async function untilLockWaits(sql: Bun.SQL, n: number): Promise<Record<string, number>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const waits = await lockWaits(sql);
    if (Object.values(waits).reduce((sum, w) => sum + w, 0) >= n) return waits;
    if (Date.now() > deadline) {
      throw new Error(`expected ${n} backends waiting on a lock, saw ${JSON.stringify(waits)}`);
    }
    await Bun.sleep(10);
  }
}

/** The advisory locks held by the backends waiting to record a plugin row snapshot. */
async function advisoryLocksOfSnapshotWriters(sql: Bun.SQL): Promise<number> {
  const [row] = (await sql`
    SELECT count(*)::int AS n FROM pg_locks l
    WHERE l.locktype = 'advisory' AND l.granted AND l.pid IN (
      SELECT w.pid FROM pg_locks w
      WHERE NOT w.granted AND w.locktype = 'relation'
        AND w.relation = 'plugin_row_snapshots'::regclass
    )
  `) as { n: number }[];
  return row?.n ?? 0;
}

/**
 * Hold plugin_row_snapshots against inserts while `body` starts writers and
 * checks where they wait ({@link holdRowSnapshots}); they go on once it
 * returns their promises.
 */
async function withRowSnapshotsHeld(
  body: (sql: Bun.SQL) => Promise<Promise<unknown>[]>,
): Promise<unknown[]> {
  const sql = new SQL(ADMIN_URL as string);
  const held = await sql.reserve();
  let running: Promise<unknown>[] = [];
  try {
    await held.unsafe("BEGIN");
    await held.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await holdRowSnapshots(held as unknown as Bun.SQL);
    running = await body(sql as unknown as Bun.SQL);
  } finally {
    await held.unsafe("COMMIT");
    held.release();
  }
  try {
    return await Promise.all(running);
  } finally {
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
    expect(await liveRows(key)).toEqual([{ value: "translated", branch: null }]);
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
    expect(await liveRows(key)).toEqual([{ value: "from-x", branch: null }]);
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
    expect((await liveRows(key)).filter((r) => r.branch === null)).toEqual([
      { value: "from-x", branch: null },
    ]);
    await stageIsolated(y);
    expect(await liveRows(key)).toEqual([{ value: "from-y", branch: null }]);
  });

  it("two unstaged duplicates in the shared draft fold into the key's main row at one Stage", async () => {
    const key = nextKey();
    const a = await newChat("dup-a");
    const b = await newChat("dup-b");
    await landed(await call(a.invocation, "insert", { address: key, value: "from-a" }));
    await landed(await call(b.invocation, "insert", { address: key, value: "from-b" }));
    await landed(await call(MAIN, "upsert", { address: key, value: "main" }));

    // A draft Stage takes every pending plugin row of the draft (they can
    // shape URLs): both land on the key's row, and one row is left, with
    // the state written last.
    await stage(a);
    expect(await liveRows(key)).toEqual([{ value: "from-b", branch: null }]);
  });

  it("of several unstaged rows of one key, the Stage lands the one written last, whatever its id", async () => {
    const key = nextKey();
    const a = await newChat("latest-a");
    const b = await newChat("latest-b");
    // What two chats left before #1659: a row each, from a list then an insert.
    const ra = await landed<{ id: string }>(
      await call(a.invocation, "insert", { address: key, value: "from-a" }),
    );
    const rb = await landed<{ id: string }>(
      await call(b.invocation, "insert", { address: key, value: "from-b" }),
    );
    // The row with the smaller id is written last, so id order and write
    // order disagree: the read rule shows the later write, and so must the
    // Stage.
    const [smaller, owner] = ra.id < rb.id ? [ra, a] : [rb, b];
    await landed(await call(owner.invocation, "update", { id: smaller.id, value: "latest" }));
    await stage(a, b);
    expect(await liveRows(key)).toEqual([{ value: "latest", branch: null }]);
  });

  it("records the latest upsert's key, also when a table's key changes and changes back", async () => {
    await landed(await call(MAIN, "upsert", { address: nextKey(), value: "a" }));
    await landed(await call(MAIN, "upsert", { address: nextKey(), value: "b" }));
    expect(await recordedKeyOf("entries")).toEqual(["address", "lang"]);
    await landed(await call(MAIN, "upsert_lang_only"));
    expect(await recordedKeyOf("entries")).toEqual(["lang"]);
    // Back to the first key: the Stage must fold by it again, not by `lang`
    // (which would fold rows of different addresses into one).
    await landed(await call(MAIN, "upsert", { address: nextKey(), value: "c" }));
    expect(await recordedKeyOf("entries")).toEqual(["address", "lang"]);
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
    expect(await liveRows(key)).toEqual([{ value: "from-a", branch: null }]);
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

  it("a Stage replayed after a failed build lands the same way: one row, same id, same value", async () => {
    const key = nextKey();
    const a = await newChat("retry-a");
    await landed(await call(a.invocation, "upsert", { address: key, value: "translated" }));
    // A main row of the key with the smallest id: the key's row, onto which
    // the Stage lands the chat's row and drops it.
    const mainId = `00000000-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`;
    await insertMainRow(mainId, key, null);

    // The Stage merges, its build fails: the chat's changes stay pending.
    await mergeDraft([a], true);
    const first = await physicalRows(key);
    expect(first).toEqual([{ id: mainId, value: "translated", branch: null }]);
    // The retry merges the same pending states again.
    await mergeDraft([a], true);
    expect(await physicalRows(key)).toEqual(first);
    await stage(a);
    expect(await physicalRows(key)).toEqual(first);
  });

  it("a main-line upsert racing a Stage for a key without a main row leaves one row", async () => {
    const key = nextKey();
    const a = await newChat("race-stage-a");
    await landed(await call(a.invocation, "upsert", { address: key, value: "translated" }));

    // Both hold what they read until the other may have written: the
    // upsert its insert, the Stage the chat's row graduated to main.
    const results = await atOnce<unknown>(
      () => [
        mergeDraft([a], false),
        call(MAIN, "upsert", { address: key, value: null, keep: true }),
      ],
      2,
      holdRowSnapshots,
    );
    await landed(results[1] as Awaited<ReturnType<typeof call>>);
    const rows = await physicalRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: "translated", branch: null });
  });

  it("a Stage of a few keys of a table locks only those: an upsert of another key does not wait for it", async () => {
    const [key, other] = [nextKey(), nextKey()];
    const a = await newChat("few-keys");
    await landed(await call(a.invocation, "upsert", { address: key, value: "translated" }));

    const [, placeholder] = await withRowSnapshotsHeld(async (sql) => {
      const staged = mergeDraft([a], false);
      // The Stage has landed its row and waits to record its snapshot.
      await untilLockWaits(sql, 1);
      const upsert = call(MAIN, "upsert", { address: other, value: null, keep: true });
      // The upsert got its locks and wrote its row: it waits on the held
      // table too, not on the Stage.
      expect(await untilLockWaits(sql, 2)).toEqual({ relation: 2 });
      return [staged, upsert];
    });
    expect(await landed(placeholder as Awaited<ReturnType<typeof call>>)).toMatchObject({
      created: true,
    });
    expect(await liveRows(key)).toEqual([{ value: "translated", branch: null }]);
    expect(await liveRows(other)).toEqual([{ value: null, branch: null }]);
  });

  it("a Stage of many keys of a table locks the table, not each key, and a racing upsert still leaves one row", async () => {
    const a = await newChat("many-keys");
    const keys = Array.from({ length: STAGE_KEY_LOCKS_PER_TABLE + 8 }, () => nextKey());
    for (const key of keys) {
      await landed(await call(a.invocation, "upsert", { address: key, value: "translated" }));
    }

    const [, placeholder] = await withRowSnapshotsHeld(async (sql) => {
      const staged = mergeDraft([a], false);
      await untilLockWaits(sql, 1);
      // The Stage has landed every row and waits to record their snapshots,
      // holding its locks: one for the table. A lock per key would let a
      // Stage of a whole site's translations run the server out of lock
      // slots ("out of shared memory").
      expect(await advisoryLocksOfSnapshotWriters(sql)).toBe(1);
      // A main-line upsert of one of its keys waits for the Stage.
      const upsert = call(MAIN, "upsert", { address: keys[0], value: null, keep: true });
      expect(await untilLockWaits(sql, 2)).toEqual({ relation: 1, advisory: 1 });
      return [staged, upsert];
    });
    // It then finds the row the Stage graduated and keeps it.
    expect(await landed(placeholder as Awaited<ReturnType<typeof call>>)).toMatchObject({
      created: false,
    });
    for (const key of keys) {
      expect(await liveRows(key)).toEqual([{ value: "translated", branch: null }]);
    }
  }, 120_000);

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
