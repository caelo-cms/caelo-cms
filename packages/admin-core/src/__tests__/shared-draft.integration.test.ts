// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part A — the site's shared draft.
 *
 *   - new chats bind to ONE draft branch and see each other's changes;
 *   - no locks between draft chats: optimistic per-entity versioning turns
 *     a write over another chat's newer change into a gentle conflict;
 *   - "undo this chat" drops exactly its changes, warns before it would
 *     drop another chat's later change, and needs confirmation for that;
 *   - a selective merge ships exactly the selected chats' changes (plus
 *     other chats' changes to the same entities, reported);
 *   - experiments and migrations stay isolated; a chat that existed before
 *     the draft keeps its own branch;
 *   - discarding a draft chat drops only its own changes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t620-draft-";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t620-draft" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

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

async function seedModule(slug: string): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}${slug}`,
      displayName: slug,
      html: `<p>${slug} v0</p>`,
    })
  ).moduleId;
}

interface Chat {
  id: string;
  branch: string;
  kind: string;
  ctx: ExecutionContext;
}

async function chat(title: string, isolation?: "experiment" | "migration"): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string; branchKind: string }>(
    SYS,
    "chat.create_session",
    { title: `${PFX}${title}`, ...(isolation ? { isolation } : {}) },
  );
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    kind: v.branchKind,
    ctx: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `t620-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

async function html(ctx: ExecutionContext, moduleId: string): Promise<string> {
  return (await op<{ module: { html: string } }>(ctx, "modules.get", { moduleId })).module.html;
}

async function pendingModules(chatSessionId: string): Promise<string[]> {
  const v = await op<{ pending: { globals: { kind: string; entityId: string }[] } }>(
    SYS,
    "chat.list_pending_changes",
    { chatSessionId },
  );
  return v.pending.globals.filter((g) => g.kind === "module").map((g) => g.entityId);
}

describe("#620 shared draft", () => {
  it("binds new chats to one draft and shows each chat the others' changes", async () => {
    const m = await seedModule("hero");
    const a = await chat("Website");
    const b = await chat("Pricing");
    expect(a.kind).toBe("draft");
    expect(b.branch).toBe(a.branch);
    await op(a.ctx, "modules.update", { moduleId: m, html: "<p>hero from A</p>" });
    expect(await html(b.ctx, m)).toBe("<p>hero from A</p>");
    expect(await html(SYS, m)).not.toContain("from A");
    // Each chat lists only what IT changed.
    expect(await pendingModules(a.id)).toEqual([m]);
    expect(await pendingModules(b.id)).toEqual([]);
  });

  it("turns a write over another chat's newer change into a conflict, then lets the re-read retry through", async () => {
    const m = await seedModule("card");
    const a = await chat("A writes first");
    const b = await chat("B writes second");
    await op(a.ctx, "modules.update", { moduleId: m, html: "<p>card from A</p>" });

    const stale = await execute(registry, adapter, b.ctx, "modules.update", {
      moduleId: m,
      html: "<p>card from B (written blind)</p>",
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    const message = "message" in stale.error ? stale.error.message : "";
    expect(message).toContain("Conflict");
    expect(message).toContain(`${PFX}A writes first`);
    expect(await html(b.ctx, m)).toBe("<p>card from A</p>");

    // B re-read (the conflict told it); its retry builds on A's change.
    await op(b.ctx, "modules.update", { moduleId: m, css: ".b{}" });
    const seen = await op<{ module: { html: string; css: string } }>(b.ctx, "modules.get", {
      moduleId: m,
    });
    expect(seen.module).toMatchObject({ html: "<p>card from A</p>", css: ".b{}" });

    // Now A is the one that has not seen B's change.
    const aAgain = await execute(registry, adapter, a.ctx, "modules.update", {
      moduleId: m,
      html: "<p>card from A again</p>",
    });
    expect(aAgain.ok).toBe(false);
  });

  it("undoes one chat, warns before it would also undo another chat's later change, and needs confirmation", async () => {
    const solo = await seedModule("solo");
    const shared = await seedModule("shared");
    const a = await chat("Undo me");
    const b = await chat("Built on top");
    await op(a.ctx, "modules.update", { moduleId: solo, html: "<p>solo by A</p>" });
    await op(a.ctx, "modules.update", { moduleId: shared, html: "<p>shared by A</p>" });
    // B builds on A's change to `shared` (first touch conflicts, retry passes).
    expect(
      (await execute(registry, adapter, b.ctx, "modules.update", { moduleId: shared, css: ".x{}" }))
        .ok,
    ).toBe(false);
    await op(b.ctx, "modules.update", { moduleId: shared, css: ".x{}" });
    const created = await op<{ moduleId: string }>(a.ctx, "modules.create", {
      slug: `${PFX}new-by-a`,
      displayName: "New by A",
      html: "<p>new</p>",
    });

    const first = await op<{
      applied: boolean;
      overlap: { title: string; labels: string[] }[];
    }>(SYS, "chat.undo_changes", { chatSessionId: a.id });
    expect(first.applied).toBe(false);
    expect(first.overlap.map((o) => o.title)).toEqual([`${PFX}Built on top`]);
    expect(first.overlap[0]?.labels).toContain("shared");
    expect(await html(b.ctx, solo)).toBe("<p>solo by A</p>");

    const confirmed = await op<{ applied: boolean; droppedRows: number }>(
      SYS,
      "chat.undo_changes",
      { chatSessionId: a.id, confirmOverlap: true },
    );
    expect(confirmed.applied).toBe(true);
    expect(confirmed.droppedRows).toBe(1);
    expect(await html(b.ctx, solo)).not.toContain("by A");
    const sharedNow = await op<{ module: { html: string; css: string } }>(b.ctx, "modules.get", {
      moduleId: shared,
    });
    expect(sharedNow.module.html).not.toContain("by A");
    expect(sharedNow.module.css).not.toBe(".x{}");
    expect(await pendingModules(a.id)).toEqual([]);
    expect(await pendingModules(b.id)).toEqual([]);
    const createdRow = await asSystem(
      (tx) =>
        tx`SELECT deleted_at FROM modules WHERE id = ${created.moduleId}::uuid` as Promise<
          { deleted_at: Date | null }[]
        >,
    );
    expect(createdRow[0]?.deleted_at).not.toBeNull();
  });

  it("undoes a chat without overlap directly", async () => {
    const m = await seedModule("own");
    const a = await chat("Only me");
    await op(a.ctx, "modules.update", { moduleId: m, html: "<p>own by A</p>" });
    const r = await op<{ applied: boolean; undoneSnapshots: number }>(SYS, "chat.undo_changes", {
      chatSessionId: a.id,
    });
    expect(r).toMatchObject({ applied: true, undoneSnapshots: 1 });
    expect(await html(a.ctx, m)).not.toContain("by A");
  });

  it("merges exactly the selected chats' changes, plus other chats' changes to the same entities", async () => {
    const m1 = await seedModule("sel-1");
    const m2 = await seedModule("sel-2");
    const a = await chat("Selected");
    const b = await chat("Not selected");
    const c = await chat("Rides along");
    await op(a.ctx, "modules.update", { moduleId: m1, html: "<p>m1 by A</p>" });
    await op(b.ctx, "modules.update", { moduleId: m2, html: "<p>m2 by B</p>" });
    // C edits m1 after A (re-read first).
    expect(
      (await execute(registry, adapter, c.ctx, "modules.update", { moduleId: m1, css: ".c{}" })).ok,
    ).toBe(false);
    await op(c.ctx, "modules.update", { moduleId: m1, css: ".c{}" });

    const merged = await op<{
      entityCount: number;
      alsoIncludes: { title: string; labels: string[] }[];
    }>(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    expect(merged.entityCount).toBe(1);
    expect(merged.alsoIncludes.map((x) => x.title)).toEqual([`${PFX}Rides along`]);
    const live = await asSystem(
      (tx) =>
        tx`SELECT id::text AS id, html, css FROM modules WHERE id IN (${m1}::uuid, ${m2}::uuid)` as Promise<
          { id: string; html: string; css: string }[]
        >,
    );
    const byId = new Map(live.map((r) => [r.id, r]));
    expect(byId.get(m1)).toMatchObject({ html: "<p>m1 by A</p>", css: ".c{}" });
    expect(byId.get(m2)?.html).not.toContain("by B");
    expect(await pendingModules(a.id)).toEqual([]);
    expect(await pendingModules(c.id)).toEqual([]);
    expect(await pendingModules(b.id)).toEqual([m2]);
  });

  it("keeps experiments isolated, and a draft write takes an experiment's held entity over", async () => {
    const m = await seedModule("exp");
    const draft = await chat("Draft chat");
    const exp = await chat("Try a redesign", "experiment");
    expect(exp.kind).toBe("experiment");
    expect(exp.branch).not.toBe(draft.branch);
    await op(exp.ctx, "modules.update", { moduleId: m, html: "<p>redesign</p>" });
    expect(await html(draft.ctx, m)).not.toContain("redesign");
    // The draft writes the same module: it adopts the experiment's change.
    await op(draft.ctx, "modules.update", { moduleId: m, css: ".d{}" });
    expect(await html(draft.ctx, m)).toBe("<p>redesign</p>");
    expect(await pendingModules(exp.id)).toEqual([]);
  });

  it("isolates a draft chat only before it changed anything", async () => {
    const m = await seedModule("iso");
    const fresh = await chat("Fresh");
    const moved = await op<{ chatBranchId: string; branchKind: string }>(
      SYS,
      "chat.isolate_session",
      { chatSessionId: fresh.id, reason: "migration" },
    );
    expect(moved.branchKind).toBe("migration");
    expect(moved.chatBranchId).not.toBe(fresh.branch);

    const busy = await chat("Busy");
    await op(busy.ctx, "modules.update", { moduleId: m, html: "<p>busy</p>" });
    const refused = await execute(registry, adapter, SYS, "chat.isolate_session", {
      chatSessionId: busy.id,
      reason: "experiment",
    });
    expect(refused.ok).toBe(false);
  });

  it("moves a chat onto its own migration branch when it proposes a site import", async () => {
    const m = await chat("Migrate my site");
    const proposed = await op<{ runId: string; migrationBranch: boolean }>(
      m.ctx,
      "imports.propose_run",
      { sourceUrl: "https://t620-migrate.example/", depth: 1, maxPages: 5 },
    );
    expect(proposed.migrationBranch).toBe(true);
    const after = await op<{ chatBranchId: string; branchKind: string }>(
      SYS,
      "chat.get_branch_id",
      { chatSessionId: m.id },
    );
    expect(after.branchKind).toBe("migration");
    expect(after.chatBranchId).not.toBe(m.branch);
  });

  it("leaves a chat from before the draft on its own branch, stageable as before", async () => {
    const m = await seedModule("legacy");
    const legacy = await chat("Old chat", "experiment");
    await asSystem(
      (tx) => tx`UPDATE chat_sessions SET branch_kind = 'legacy' WHERE id = ${legacy.id}::uuid`,
    );
    await op(legacy.ctx, "modules.update", { moduleId: m, html: "<p>legacy work</p>" });
    const overview = await op<{ chats: { chatSessionId: string; branchKind: string }[] }>(
      SYS,
      "chat.list_open_changes",
      {},
    );
    expect(overview.chats.find((c) => c.chatSessionId === legacy.id)?.branchKind).toBe("legacy");
    const merged = await op<{ entityCount: number }>(SYS, "chat.merge_to_main", {
      chatSessionId: legacy.id,
    });
    expect(merged.entityCount).toBe(1);
  });

  it("discards a draft chat's own changes only and closes it", async () => {
    const mine = await seedModule("discard-mine");
    const theirs = await seedModule("discard-theirs");
    const a = await chat("Discard me");
    const b = await chat("Keep me");
    await op(a.ctx, "modules.update", { moduleId: mine, html: "<p>gone</p>" });
    await op(b.ctx, "modules.update", { moduleId: theirs, html: "<p>kept</p>" });
    const r = await op<{ discarded: boolean }>(SYS, "chat.discard_branch", { chatSessionId: a.id });
    expect(r.discarded).toBe(true);
    expect(await html(b.ctx, mine)).not.toContain("gone");
    expect(await html(b.ctx, theirs)).toBe("<p>kept</p>");
    const closed = await asSystem(
      (tx) =>
        tx`SELECT discarded_at FROM chat_sessions WHERE id = ${a.id}::uuid` as Promise<
          { discarded_at: Date | null }[]
        >,
    );
    expect(closed[0]?.discarded_at).not.toBeNull();
  });
});
