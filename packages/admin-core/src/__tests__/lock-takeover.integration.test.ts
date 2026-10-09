// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — a lock is TAKEN OVER, never a blocking wall.
 *
 * When chat B writes an entity chat A holds with unstaged changes, B
 * adopts A's change: A's branch snapshots of the entity move to B's
 * branch, the lock moves with them, B's write builds on the adopted
 * state, and both chats are told. Nothing is lost (A's change ships with
 * B) and nothing is silently overwritten (A's later Stage no longer
 * replays it). There is no time-based expiry: an ancient lock still
 * moves its change along instead of being silently dropped.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t620-takeover-";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t620-seed" };

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

/** Templates survive the per-file reset (seed-bearing) — drop ours. */
async function wipeTemplates(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT p.id FROM pages p JOIN templates t ON t.id = p.template_id WHERE t.slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipeTemplates();
});

afterAll(async () => {
  await wipeTemplates();
  await adapter.close();
});

async function seedModule(slug: string, html: string): Promise<string> {
  const r = await execute(registry, adapter, SYS, "modules.create", {
    slug: `${PFX}${slug}`,
    displayName: slug,
    html,
  });
  if (!r.ok) throw new Error(`seed module: ${JSON.stringify(r.error)}`);
  return (r.value as { moduleId: string }).moduleId;
}

async function chat(title: string): Promise<{ id: string; branch: string; ctx: ExecutionContext }> {
  const r = await execute(registry, adapter, SYS, "chat.create_session", {
    title: `${PFX}${title}`,
  });
  if (!r.ok) throw new Error(`seed chat: ${JSON.stringify(r.error)}`);
  const v = r.value as { chatSessionId: string; chatBranchId: string };
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    ctx: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `t620-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

async function pendingModuleIds(chatSessionId: string): Promise<string[]> {
  const r = await execute(registry, adapter, SYS, "chat.list_pending_changes", { chatSessionId });
  if (!r.ok) throw new Error(`pending: ${JSON.stringify(r.error)}`);
  const v = r.value as { pending: { globals: { kind: string; entityId: string }[] } };
  return v.pending.globals.filter((g) => g.kind === "module").map((g) => g.entityId);
}

async function notes(chatSessionId: string): Promise<string[]> {
  const r = await execute(registry, adapter, SYS, "chat.drain_takeover_notices", {
    chatSessionId,
  });
  if (!r.ok) throw new Error(`drain: ${JSON.stringify(r.error)}`);
  return (r.value as { notes: string[] }).notes;
}

describe("#620 lock takeover", () => {
  it("adopts the holder's unstaged change, builds on it, and moves the lock", async () => {
    const moduleId = await seedModule("hero", "<p>v0</p>");
    const a = await chat("Website");
    const b = await chat("Pricing");

    const wA = await execute(registry, adapter, a.ctx, "modules.update", {
      moduleId,
      html: "<p>from A</p>",
    });
    expect(wA.ok).toBe(true);
    expect(await pendingModuleIds(a.id)).toEqual([moduleId]);

    // B changes only the display name — the write must build on A's html.
    const wB = await execute(registry, adapter, b.ctx, "modules.update", {
      moduleId,
      displayName: "Hero (B)",
    });
    expect(wB.ok).toBe(true);

    const seenByB = await execute(registry, adapter, b.ctx, "modules.get", { moduleId });
    if (!seenByB.ok) throw new Error("get as B");
    const mod = (seenByB.value as { module: { html: string; displayName: string } }).module;
    expect(mod.html).toBe("<p>from A</p>");
    expect(mod.displayName).toBe("Hero (B)");

    // A's pending set lost the module, B's gained it; the lock moved.
    expect(await pendingModuleIds(a.id)).toEqual([]);
    expect(await pendingModuleIds(b.id)).toEqual([moduleId]);
    const lock = await asSystem(
      (tx) =>
        tx`
        SELECT chat_session_id::text AS holder FROM chat_entity_locks
        WHERE entity_kind = 'module' AND entity_id = ${moduleId}::uuid
      ` as Promise<{ holder: string }[]>,
    );
    expect(lock[0]?.holder).toBe(b.id);
    const record = await asSystem(
      (tx) =>
        tx`
        SELECT from_chat_session_id::text AS from_id, to_chat_session_id::text AS to_id,
               adopted_snapshot_count, label
        FROM chat_lock_takeovers WHERE entity_id = ${moduleId}::uuid
      ` as Promise<
          { from_id: string; to_id: string; adopted_snapshot_count: number; label: string }[]
        >,
    );
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ from_id: a.id, to_id: b.id, adopted_snapshot_count: 1 });

    // Both chats are told, exactly once.
    const toB = await notes(b.id);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toContain(`${PFX}Website`);
    expect(toB[0]).toContain("adopted");
    expect(await notes(b.id)).toEqual([]);
    const toA = await notes(a.id);
    expect(toA).toHaveLength(1);
    expect(toA[0]).toContain(`${PFX}Pricing`);

    // Staging A no longer replays its old html over B's change; staging B
    // ships both edits.
    const mergeA = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: a.id,
    });
    if (!mergeA.ok) throw new Error(`merge A: ${JSON.stringify(mergeA.error)}`);
    expect((mergeA.value as { entityCount: number }).entityCount).toBe(0);
    const mergeB = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: b.id,
    });
    if (!mergeB.ok) throw new Error(`merge B: ${JSON.stringify(mergeB.error)}`);
    const live = await asSystem(
      (tx) =>
        tx`SELECT html, display_name FROM modules WHERE id = ${moduleId}::uuid` as Promise<
          { html: string; display_name: string }[]
        >,
    );
    expect(live[0]).toEqual({ html: "<p>from A</p>", display_name: "Hero (B)" });
  });

  it("has no time-based expiry: an ancient lock still moves its change along", async () => {
    const moduleId = await seedModule("old", "<p>v0</p>");
    const a = await chat("Forgotten");
    const b = await chat("Fresh");
    expect(
      (await execute(registry, adapter, a.ctx, "modules.update", { moduleId, html: "<p>A</p>" }))
        .ok,
    ).toBe(true);
    await asSystem(
      (tx) => tx`
        UPDATE chat_entity_locks SET locked_at = now() - interval '90 days'
        WHERE entity_id = ${moduleId}::uuid
      `,
    );
    const wB = await execute(registry, adapter, b.ctx, "modules.update", {
      moduleId,
      css: ".x{}",
    });
    expect(wB.ok).toBe(true);
    const seen = await execute(registry, adapter, b.ctx, "modules.get", { moduleId });
    if (!seen.ok) throw new Error("get");
    expect((seen.value as { module: { html: string } }).module.html).toBe("<p>A</p>");
    const record = await asSystem(
      (tx) =>
        tx`SELECT adopted_snapshot_count FROM chat_lock_takeovers WHERE entity_id = ${moduleId}::uuid` as Promise<
          { adopted_snapshot_count: number }[]
        >,
    );
    expect(record[0]?.adopted_snapshot_count).toBe(1);
  });

  it("adopts the rows the holder created that an adopted page layout points at", async () => {
    const tpl = await execute(registry, adapter, SYS, "templates.create", {
      slug: `${PFX}tpl`,
      displayName: "T",
      html: "<main>{{content}}</main>",
      css: "",
    });
    if (!tpl.ok) throw new Error("tpl");
    const templateId = (tpl.value as { templateId: string }).templateId;
    const blocks = await execute(registry, adapter, SYS, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    if (!blocks.ok) throw new Error("blocks");
    const page = await execute(registry, adapter, SYS, "pages.create", {
      slug: `${PFX}page`,
      title: "Page",
      templateId,
      status: "draft",
    });
    if (!page.ok) throw new Error("page");
    const pageId = (page.value as { pageId: string }).pageId;

    const a = await chat("Builder");
    const b = await chat("Editor");
    // A creates a NEW module on its branch and places it on the main page.
    const created = await execute(registry, adapter, a.ctx, "modules.create", {
      slug: `${PFX}new-section`,
      displayName: "New section",
      html: "<section>new</section>",
    });
    if (!created.ok) throw new Error(`create on A: ${JSON.stringify(created.error)}`);
    const newModuleId = (created.value as { moduleId: string }).moduleId;
    const placed = await execute(registry, adapter, a.ctx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [newModuleId] }],
    });
    expect(placed.ok).toBe(true);

    // B renames the page → takes the page over, and with it the new module.
    const wB = await execute(registry, adapter, b.ctx, "pages.update", {
      pageId,
      title: "Renamed by B",
    });
    expect(wB.ok).toBe(true);

    const tag = await asSystem(
      (tx) =>
        tx`SELECT chat_branch_id::text AS branch FROM modules WHERE id = ${newModuleId}::uuid` as Promise<
          { branch: string }[]
        >,
    );
    expect(tag[0]?.branch).toBe(b.branch);
    const layout = await execute(registry, adapter, b.ctx, "pages.get_with_modules", { pageId });
    if (!layout.ok) throw new Error(`layout as B: ${JSON.stringify(layout.error)}`);
    expect(JSON.stringify(layout.value)).toContain(newModuleId);
    // The module B can now see is B's to edit (its lock came along too).
    const editNew = await execute(registry, adapter, b.ctx, "modules.update", {
      moduleId: newModuleId,
      html: "<section>edited by B</section>",
    });
    expect(editNew.ok).toBe(true);
  });
});
