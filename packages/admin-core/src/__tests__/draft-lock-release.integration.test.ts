// SPDX-License-Identifier: MPL-2.0

/**
 * Releasing the shared draft's idle locks (`releaseIdleDraftLocks`), which a
 * Stage's finalize, an undo and a chat's close run.
 *
 * On searchVIU (2026-11-26) `chat.finalize_draft_stage` hit the 60 s
 * statement timeout in this statement: it walked the snapshot history, one
 * EXISTS per lock kind joining every snapshot of the entity to its header,
 * and three of them hashed whole snapshot tables. It reads the draft head
 * now (`draft_pending_entities`, #1268), so its cost follows the branch's
 * locks and pending entities, whatever the history holds:
 *
 *   - after a Stage, the staged entities' locks go and the others stay;
 *   - per lock kind, a lock stays exactly while the head holds a pending
 *     row of a kind that keeps it — a page's section content (by its page)
 *     included — and the live-write kinds always go;
 *   - the statement reads no snapshot table (its plan), which the history
 *     walk did for every kind.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { idleDraftLocksSql } from "../draft.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t-lock-release-";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t-lock-release" };

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
      requestId: `t-lock-release-${title}`,
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

async function locksOn(branch: string): Promise<{ kind: string; entity: string }[]> {
  const conn = new SQL(ADMIN_URL as string, { max: 1 });
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`SELECT entity_kind AS kind, entity_id::text AS entity FROM chat_entity_locks
                 WHERE chat_branch_id = ${branch}::uuid ORDER BY entity_kind, entity_id`;
    })) as { kind: string; entity: string }[];
  } finally {
    await conn.end();
  }
}

describe("releasing the draft's idle locks (searchVIU, 2026-11-26)", () => {
  it("drops the staged entities' locks after a Stage and keeps the others", async () => {
    const staged = await seedModule("staged");
    const kept = await seedModule("kept");
    const a = await chat("Staged");
    const b = await chat("Not staged");
    await op(a.ctx, "modules.update", { moduleId: staged, html: "<p>by A</p>" });
    await op(b.ctx, "modules.update", { moduleId: kept, html: "<p>by B</p>" });
    const before = (await locksOn(a.branch)).filter((l) => [staged, kept].includes(l.entity));
    expect(before.map((l) => l.entity).sort()).toEqual([staged, kept].sort());

    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });

    const after = (await locksOn(a.branch)).filter((l) => [staged, kept].includes(l.entity));
    expect(after).toEqual([{ kind: "module", entity: kept }]);
  });

  it("keeps a lock exactly while the head holds a pending row that needs it", async () => {
    const draft = (await chat("Kinds")).branch;
    const otherBranch = crypto.randomUUID();
    interface Case {
      readonly lock: string;
      readonly entity: string;
      /** The head row on the draft: its kind, entity and page. */
      readonly head: { kind: string; entity: string; page: string | null } | null;
      readonly kept: boolean;
    }
    const cases: Case[] = [];
    const add = (lock: string, headKind: string | null, kept: boolean) => {
      const entity = crypto.randomUUID();
      cases.push({
        lock,
        entity,
        head: headKind ? { kind: headKind, entity, page: null } : null,
        kept,
      });
    };
    for (const [lock, headKind] of [
      ["module", "module"],
      ["template", "template"],
      ["page", "page"],
      ["page", "pageLayout"],
      ["pageLayout", "pageLayout"],
      ["listType", "listType"],
      ["list", "list"],
      ["pageType", "pageType"],
      ["contentInstance", "contentInstance"],
      ["theme", "theme"],
      ["pluginRow", "pluginRow"],
      ["layout", "layoutBlock"],
    ] as const) {
      add(lock, headKind, true);
      add(lock, null, false);
    }
    // Another kind's pending row of the same id keeps nothing.
    add("module", "contentInstance", false);
    add("pageLayout", "page", false);
    // The live-write kinds never have pending changes.
    for (const lock of ["redirect", "siteSettings", "siteDefaults"]) add(lock, null, false);
    // A page whose section has pending content: that head row's entity is
    // the section's content row, and it names the page.
    const page = crypto.randomUUID();
    cases.push({
      lock: "page",
      entity: page,
      head: { kind: "pageModuleContent", entity: crypto.randomUUID(), page },
      kept: true,
    });

    const kept = await adapter
      .withAdminTransaction(SYS, async (tx) => {
        const head = (h: { kind: string; entity: string; page: string | null }, branch: string) =>
          tx.execute(sql`
            INSERT INTO draft_pending_entities
              (chat_branch_id, entity_kind, entity_id, owner_chat_session_id, site_snapshot_id,
               header_created_at, row_created_at, page_id)
            VALUES (${branch}::uuid, ${h.kind}, ${h.entity}::uuid, ${crypto.randomUUID()}::uuid,
                    ${crypto.randomUUID()}::uuid, now(), now(), ${h.page}::uuid)`);
        for (const c of cases) {
          await tx.execute(sql`
            INSERT INTO chat_entity_locks (entity_kind, entity_id, chat_session_id, chat_branch_id)
            SELECT ${c.lock}, ${c.entity}::uuid, cs.id, ${draft}::uuid
              FROM chat_sessions cs WHERE cs.chat_branch_id = ${draft}::uuid LIMIT 1`);
          if (c.head) await head(c.head, draft);
          // The same entity pending on another branch keeps nothing here.
          else await head({ kind: c.lock, entity: c.entity, page: null }, otherBranch);
        }
        await tx.execute(idleDraftLocksSql(draft));
        const rows = (await tx.execute(sql`
          SELECT entity_kind || ':' || entity_id AS key FROM chat_entity_locks
           WHERE chat_branch_id = ${draft}::uuid`)) as unknown as { key: string }[];
        // The fixture is no state a maintainer wrote: roll it back.
        throw new KeptLocks(new Set(rows.map((r) => r.key)));
      })
      .catch((e: unknown) => {
        if (e instanceof KeptLocks) return e.keys;
        throw e;
      });
    const outcome = (c: Case, keptNow: boolean) => ({
      lock: c.lock,
      head: c.head?.kind ?? null,
      kept: keptNow,
    });
    expect(cases.map((c) => outcome(c, kept.has(`${c.lock}:${c.entity}`)))).toEqual(
      cases.map((c) => outcome(c, c.kept)),
    );
  });

  it("reads the head and its locks only, never a snapshot table", async () => {
    const draft = (await chat("Plan")).branch;
    const plan = await adapter.withAdminTransaction(SYS, async (tx) => {
      const rows = (await tx.execute(sql`EXPLAIN ${idleDraftLocksSql(draft)}`)) as unknown as {
        "QUERY PLAN": string;
      }[];
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    // What the plan scans (`... Scan on <relation>`, an index scan names
    // its relation after the index).
    const scanned = new Set([...plan.matchAll(/Scan (?:using \w+ )?on (\w+)/g)].map((m) => m[1]));
    expect(scanned.has("draft_pending_entities")).toBe(true);
    expect([...scanned].filter((r) => r?.endsWith("snapshots"))).toEqual([]);
    expect(plan).not.toMatch(/snapshots/);
  });
});

/** Carries the kept locks out of a transaction that must roll back. */
class KeptLocks extends Error {
  constructor(readonly keys: ReadonlySet<string>) {
    super("rolled back on purpose");
  }
}
