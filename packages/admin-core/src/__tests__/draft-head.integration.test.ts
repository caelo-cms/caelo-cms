// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1268 — the draft head (`draft_pending_entities`, migration 0433).
 *
 *   - a write puts one head row per (entity, owner chat) on the branch,
 *     pointing at the owner's newest pending snapshot;
 *   - a partial Stage, an undo of the newest of several writes and a
 *     discard leave the head exact (the preload's after-file check holds
 *     every other file to maintained == rebuilt; here each step is checked);
 *   - the pill, the cross-chat banner, the changes page and the Stage list
 *     count the same entities, themes and layout chrome included;
 *   - the rebuild op reports drift and repairs it;
 *   - the TypeScript kinds mirror the SQL registry;
 *   - 20 concurrent writers on the shared draft, subagents of one chat
 *     among them, never wait on each other through the head.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { DRAFT_HEAD_KINDS } from "../draft.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t1268-head-";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t1268" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string, { max: 1 });
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

interface Chat {
  id: string;
  branch: string;
  ctx: ExecutionContext;
}

async function chat(title: string): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
  });
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    ctx: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `t1268-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

async function seedModule(slug: string): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}${slug}`,
      displayName: slug,
      html: `<p>${slug} v0</p>`,
    })
  ).moduleId;
}

/**
 * Write a module from a chat. A write over another chat's newer change is
 * refused once as a conflict (which records that this chat has now seen
 * it); the retry builds on it — what the AI does after the conflict.
 */
async function writeModule(c: Chat, moduleId: string, html: string): Promise<void> {
  const first = await execute(registry, adapter, c.ctx, "modules.update", { moduleId, html });
  if (first.ok) return;
  if (!("conflict" in first.error && first.error.conflict)) {
    throw new Error(`modules.update: ${JSON.stringify(first.error)}`);
  }
  await op(c.ctx, "modules.update", { moduleId, html });
}

interface HeadRow {
  kind: string;
  entity: string;
  owner: string | null;
  header: string;
}

async function head(branch: string): Promise<HeadRow[]> {
  return asSystem(
    (tx) =>
      tx`SELECT entity_kind AS kind, entity_id::text AS entity, owner_chat_session_id::text AS owner,
                site_snapshot_id::text AS header
           FROM draft_pending_entities WHERE chat_branch_id = ${branch}::uuid
          ORDER BY entity_kind, entity_id, owner_chat_session_id` as Promise<HeadRow[]>,
  );
}

/** Maintained head == head rebuilt from the history (empty = consistent). */
async function drift(): Promise<unknown[]> {
  return asSystem(
    (tx) =>
      tx.unsafe(`
        WITH computed AS (SELECT * FROM caelo_draft_head_computed())
        SELECT 'stale' AS side, to_jsonb(s) AS row
          FROM (SELECT * FROM draft_pending_entities EXCEPT SELECT * FROM computed) s
        UNION ALL
        SELECT 'missing', to_jsonb(m)
          FROM (SELECT * FROM computed EXCEPT SELECT * FROM draft_pending_entities) m`) as Promise<
        unknown[]
      >,
  );
}

async function newestModuleHeader(c: Chat, moduleId: string): Promise<string> {
  const rows = await asSystem(
    (tx) =>
      tx`SELECT ss.id::text AS id FROM module_snapshots ms
           JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid AND ss.chat_task_id = ${c.id}::uuid
            AND ss.staged_at IS NULL AND ss.undone_at IS NULL
          ORDER BY ss.created_at DESC, ms.created_at DESC LIMIT 1` as Promise<{ id: string }[]>,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no pending module snapshot");
  return id;
}

describe("#1268 draft head", () => {
  it("keeps one row per entity and owner, pointing at the owner's newest pending snapshot", async () => {
    const m = await seedModule("hero");
    const a = await chat("A");
    const b = await chat("B");
    await writeModule(a, m, "<p>hero A1</p>");
    await writeModule(a, m, "<p>hero A2</p>");
    await writeModule(b, m, "<p>hero B1</p>");
    const rows = (await head(a.branch)).filter((r) => r.entity === m);
    expect(rows.map((r) => r.owner).sort()).toEqual([a.id, b.id].sort());
    expect(rows.find((r) => r.owner === a.id)?.header).toBe(await newestModuleHeader(a, m));
    expect(rows.find((r) => r.owner === b.id)?.header).toBe(await newestModuleHeader(b, m));
    expect(await drift()).toEqual([]);
  });

  it("stays exact through a partial Stage", async () => {
    const x = await seedModule("stage-x");
    const y = await seedModule("stage-y");
    const a = await chat("stage A");
    const b = await chat("stage B");
    await writeModule(a, x, "<p>x from A</p>");
    await writeModule(b, y, "<p>y from B</p>");
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    const rows = await head(a.branch);
    expect(rows.some((r) => r.entity === x)).toBe(false);
    expect(rows.some((r) => r.entity === y && r.owner === b.id)).toBe(true);
    expect(await drift()).toEqual([]);
  });

  it("recomputes, not deletes, when the newest of several writes is undone", async () => {
    const m = await seedModule("undo");
    const a = await chat("undo A");
    const b = await chat("undo B");
    await writeModule(a, m, "<p>undo A</p>");
    const aHeader = await newestModuleHeader(a, m);
    await writeModule(b, m, "<p>undo B (newest)</p>");
    await op(SYS, "chat.undo_changes", { chatSessionId: b.id });
    const rows = (await head(a.branch)).filter((r) => r.entity === m);
    expect(rows).toEqual([{ kind: "module", entity: m, owner: a.id, header: aHeader }]);
    expect(await drift()).toEqual([]);
  });

  it("drops a discarded draft chat's rows and nobody else's", async () => {
    const x = await seedModule("discard-x");
    const y = await seedModule("discard-y");
    const a = await chat("discard A");
    const b = await chat("discard B");
    await writeModule(a, x, "<p>x from A</p>");
    await writeModule(b, y, "<p>y from B</p>");
    await op(SYS, "chat.discard_branch", { chatSessionId: a.id });
    const rows = await head(a.branch);
    expect(rows.some((r) => r.owner === a.id)).toBe(false);
    expect(rows.some((r) => r.entity === y && r.owner === b.id)).toBe(true);
    expect(await drift()).toEqual([]);
  });

  it("counts the same pending changes in the pill, the banner, the changes page and the Stage list", async () => {
    const m = await seedModule("count");
    const a = await chat("count A");
    const other = await chat("count observer");
    await writeModule(a, m, "<p>count 1</p>");
    await writeModule(a, m, "<p>count 2</p>");
    await op(a.ctx, "themes.update_meta", { displayName: `${PFX}theme from A` });

    const pill = await op<{ count: number; byKind: { modules: number; themes: number } }>(
      SYS,
      "chat.branch_change_count",
      { chatSessionId: a.id },
    );
    expect(pill.byKind.modules).toBe(1);
    expect(pill.byKind.themes).toBe(1);

    const banner = await op<{ chats: { chatSessionId: string; pendingCount: number }[] }>(
      SYS,
      "chat.list_open_with_pending",
      { excludeChatSessionId: other.id },
    );
    const changes = await op<{ chats: { chatSessionId: string; pendingCount: number }[] }>(
      SYS,
      "chat.list_open_changes",
      {},
    );
    const list = await op<{
      pending: { pages: unknown[]; globals: { kind: string }[]; lists: unknown[] };
      staged: { pages: unknown[]; globals: unknown[]; lists: unknown[] };
    }>(SYS, "chat.list_pending_changes", { chatSessionId: a.id });
    const listed =
      list.pending.pages.length +
      list.pending.globals.length +
      list.pending.lists.length +
      list.staged.pages.length +
      list.staged.globals.length +
      list.staged.lists.length;

    expect(pill.count).toBe(2);
    expect(banner.chats.find((c) => c.chatSessionId === a.id)?.pendingCount).toBe(pill.count);
    expect(changes.chats.find((c) => c.chatSessionId === a.id)?.pendingCount).toBe(pill.count);
    expect(listed).toBe(pill.count);
    expect(list.pending.globals.map((g) => g.kind).sort()).toEqual(["module", "theme"]);
  });

  it("pages the changes overview with a keyset cursor", async () => {
    const chats: Chat[] = [];
    for (const i of [1, 2, 3]) {
      const c = await chat(`page ${i}`);
      await writeModule(c, await seedModule(`page-${i}`), `<p>page ${i}</p>`);
      chats.push(c);
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await op<{ chats: { chatSessionId: string }[]; nextCursor: string | null }>(
        SYS,
        "chat.list_open_changes",
        { limit: 1, ...(cursor ? { cursor } : {}) },
      );
      for (const c of page.chats) {
        expect(seen.has(c.chatSessionId)).toBe(false);
        seen.add(c.chatSessionId);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    for (const c of chats) expect(seen.has(c.id)).toBe(true);
    const bad = await execute(registry, adapter, SYS, "chat.list_open_changes", {
      cursor: "not-a-cursor",
    });
    expect(bad.ok).toBe(false);
  });

  it("rebuilds from source and reports the drift it repaired", async () => {
    const m = await seedModule("rebuild");
    const a = await chat("rebuild A");
    await writeModule(a, m, "<p>rebuild</p>");
    await asSystem((tx) => tx`DELETE FROM draft_pending_entities WHERE entity_id = ${m}::uuid`);
    expect((await drift()).length).toBe(1);
    const r = await op<{ rows: number; stale: number; missing: number }>(
      SYS,
      "chat.rebuild_draft_head",
      {},
    );
    expect(r.missing).toBe(1);
    expect(r.stale).toBe(0);
    expect(await drift()).toEqual([]);
    const refused = await execute(registry, adapter, a.ctx, "chat.rebuild_draft_head", {});
    expect(refused.ok).toBe(false);
  });

  it("mirrors the SQL registry of head kinds", async () => {
    const rows = await asSystem(
      (tx) => tx`SELECT kind FROM caelo_draft_head_tables()` as Promise<{ kind: string }[]>,
    );
    expect([...rows.map((r) => r.kind), "layoutChrome"].sort()).toEqual(
      [...DRAFT_HEAD_KINDS].sort(),
    );
  });

  it("lets 20 concurrent draft writers, subagents of one chat among them, write without waiting on each other", async () => {
    const parent = await chat("concurrent parent");
    const owners: string[] = [];
    for (let i = 0; i < 20; i++) {
      if (i < 5) {
        // Subagents of one chat: their writes all belong to `parent`.
        const sub = await asSystem(
          (tx) =>
            tx`INSERT INTO chat_sessions (title, created_by, chat_branch_id, branch_kind,
                                          parent_chat_session_id, subagent_role)
               SELECT ${`${PFX}sub-${i}`}, created_by, chat_branch_id, branch_kind, id, 'worker'
                 FROM chat_sessions WHERE id = ${parent.id}::uuid
               RETURNING id::text AS id` as Promise<{ id: string }[]>,
        );
        owners.push(sub[0]?.id ?? "");
      } else {
        owners.push((await chat(`concurrent ${i}`)).id);
      }
    }
    const modules: string[] = [];
    for (let i = 0; i < 20; i++) modules.push(await seedModule(`concurrent-${i}`));

    // Every writer opens its transaction, writes a header + a module
    // snapshot (the head row is upserted by the trigger) and HOLDS the
    // transaction open until all 20 have written. A writer that had to wait
    // on another through the head would hit its lock timeout instead.
    const pools = owners.map(() => new SQL(ADMIN_URL as string, { max: 1 }));
    let release: () => void = () => {};
    const allWritten = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written = 0;
    try {
      const writers = owners.map((task, i) =>
        pools[i]?.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'ai'");
          await tx.unsafe("SET LOCAL lock_timeout = '3s'");
          const h = (await tx`
            INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id)
            VALUES (${HUMAN}::uuid, 'modules.update', ${`${PFX}concurrent`}, ${task}::uuid, ${parent.branch}::uuid)
            RETURNING id::text AS id`) as { id: string }[];
          await tx`
            INSERT INTO module_snapshots (site_snapshot_id, module_id, state)
            VALUES (${h[0]?.id}::uuid, ${modules[i]}::uuid, '{"html": "<p>concurrent</p>"}'::jsonb)`;
          written += 1;
          if (written === owners.length) release();
          await allWritten;
        }),
      );
      await Promise.all(writers);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
    const rows = (await head(parent.branch)).filter((r) => modules.includes(r.entity));
    expect(rows.length).toBe(20);
    // Subagent writes belong to their parent chat.
    expect(rows.filter((r) => r.owner === parent.id).length).toBe(5);
    expect(await drift()).toEqual([]);
  }, 60_000);
});
