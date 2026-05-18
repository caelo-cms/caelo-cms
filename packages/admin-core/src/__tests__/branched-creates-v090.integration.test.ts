// SPDX-License-Identifier: MPL-2.0

/**
 * v0.9.0 — branched-create with same-chat visibility + cross-chat
 * write-block. Pins the four invariants the v0.9.0 architecture
 * promises:
 *
 *   1. Same-chat visibility: chat-1 creates module/template/page;
 *      same-chat reads (list / get) see the new entity immediately.
 *   2. Cross-chat hidden: chat-2 reads see only main + chat-2's own
 *      branched creates. chat-1's pending creates are invisible.
 *   3. Cross-chat write-block: chat-2 references chat-1's branched
 *      module UUID (via paste or stale state) → reject with Locked
 *      error.
 *   4. Merge clears branch_id: chat.merge_to_main UPDATEs every
 *      merged entity's chat_branch_id to NULL → entity becomes
 *      visible to all chats post-merge.
 *
 * Plus the v0.5.7→v0.5.19 regression case:
 *   5. create_page → pages.get(pageId) → add_module_to_page chain
 *      works inside the SAME chat (was broken when v0.5.7 hid
 *      branched-create pages from same-chat reads too).
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
const PFX = "v090-branch-";
const sysCtx: ExecutionContext = {
  actorId: HUMAN,
  actorKind: "system",
  requestId: "v090",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${PFX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("v0.9.0 branched-create", () => {
  it("same-chat sees its own branched module; cross-chat does not", async () => {
    // Two chats, each with a branched-create module.
    const s1 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}c1-vis`,
    });
    if (!s1.ok) throw new Error("seed s1");
    const s1Branch = (s1.value as { chatBranchId: string }).chatBranchId;

    const s2 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}c2-vis`,
    });
    if (!s2.ok) throw new Error("seed s2");
    const s2Branch = (s2.value as { chatBranchId: string }).chatBranchId;

    const c1Ctx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "c1",
      chatBranchId: s1Branch,
    };
    const c2Ctx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "c2",
      chatBranchId: s2Branch,
    };

    // chat-1 creates module — branched to c1.
    const mr = await execute(registry, adapter, c1Ctx, "modules.create", {
      slug: `${PFX}vis-m1`,
      displayName: "M1",
      html: "<p>hi</p>",
    });
    if (!mr.ok) throw new Error("seed module");
    const moduleId = (mr.value as { moduleId: string }).moduleId;

    // Same-chat read (c1Ctx) — module IS visible.
    const c1Get = await execute(registry, adapter, c1Ctx, "modules.get", { moduleId });
    expect(c1Get.ok).toBe(true);

    // Cross-chat read (c2Ctx) — module is NOT visible.
    const c2Get = await execute(registry, adapter, c2Ctx, "modules.get", { moduleId });
    expect(c2Get.ok).toBe(false);

    // System read (no branch) — module is NOT visible (main-only).
    const sysGet = await execute(registry, adapter, sysCtx, "modules.get", { moduleId });
    expect(sysGet.ok).toBe(false);
  });

  it("cross-chat write-block: chat-2 cannot reference chat-1's branched module", async () => {
    // Seed a template + page on main for chat-2 to write into.
    const t = await execute(registry, adapter, sysCtx, "templates.create", {
      slug: `${PFX}block-t1`,
      displayName: "T",
      html: '<caelo-slot name="content"></caelo-slot>',
      css: "",
    });
    if (!t.ok) throw new Error("seed template");
    const templateId = (t.value as { templateId: string }).templateId;

    const p = await execute(registry, adapter, sysCtx, "pages.create", {
      slug: `${PFX}block-p1`,
      locale: "en",
      title: "Block test",
      templateId,
    });
    if (!p.ok) throw new Error("seed page");
    const pageId = (p.value as { pageId: string }).pageId;

    // chat-1 creates a branched module.
    const s1 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}c1-block`,
    });
    if (!s1.ok) throw new Error("seed s1");
    const s1Branch = (s1.value as { chatBranchId: string }).chatBranchId;
    const c1Ctx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "c1",
      chatBranchId: s1Branch,
    };
    const mr = await execute(registry, adapter, c1Ctx, "modules.create", {
      slug: `${PFX}block-m1`,
      displayName: "Branched M",
      html: "<p>x</p>",
    });
    if (!mr.ok) throw new Error("seed branched module");
    const branchedModuleId = (mr.value as { moduleId: string }).moduleId;

    // chat-2 tries to attach chat-1's branched module to the main page.
    const s2 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}c2-block`,
    });
    if (!s2.ok) throw new Error("seed s2");
    const s2Branch = (s2.value as { chatBranchId: string }).chatBranchId;
    const c2Ctx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "c2",
      chatBranchId: s2Branch,
    };
    const blocked = await execute(registry, adapter, c2Ctx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [branchedModuleId] }],
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    const err = blocked.error as { kind: string; message: string };
    expect(err.kind).toBe("Locked");
    expect(err.message).toContain("pending in another chat");
  });

  it("merge clears chat_branch_id; entity becomes visible to all chats post-merge", async () => {
    const s1 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}c1-merge`,
    });
    if (!s1.ok) throw new Error("seed s1");
    const { chatSessionId: chatId1, chatBranchId: s1Branch } = s1.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const c1Ctx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "c1",
      chatBranchId: s1Branch,
    };

    const mr = await execute(registry, adapter, c1Ctx, "modules.create", {
      slug: `${PFX}merge-m1`,
      displayName: "Merge M",
      html: "<p>x</p>",
    });
    if (!mr.ok) throw new Error("seed");
    const moduleId = (mr.value as { moduleId: string }).moduleId;

    // System read pre-merge: NOT visible.
    const before = await execute(registry, adapter, sysCtx, "modules.get", { moduleId });
    expect(before.ok).toBe(false);

    // Merge.
    const merge = await execute(registry, adapter, sysCtx, "chat.merge_to_main", {
      chatSessionId: chatId1,
    });
    expect(merge.ok).toBe(true);

    // System read post-merge: IS visible (branch_id cleared).
    const after = await execute(registry, adapter, sysCtx, "modules.get", { moduleId });
    expect(after.ok).toBe(true);

    // Verify chat_branch_id is actually NULL in the DB.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT chat_branch_id FROM modules WHERE id = ${moduleId}::uuid
        `) as unknown as { chat_branch_id: string | null }[];
        expect(rows[0]?.chat_branch_id).toBeNull();
      });
    } finally {
      await sql.end();
    }
  });

  it("v0.5.7 regression — create_page → pages.get → set_modules chain works in same chat", async () => {
    const s = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}c1-chain`,
    });
    if (!s.ok) throw new Error("seed chat");
    const sBranch = (s.value as { chatBranchId: string }).chatBranchId;
    const cCtx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "c1",
      chatBranchId: sBranch,
    };

    // Seed template on main (so pages.create's templateId is usable).
    const t = await execute(registry, adapter, sysCtx, "templates.create", {
      slug: `${PFX}chain-t1`,
      displayName: "T",
      html: '<caelo-slot name="content"></caelo-slot>',
      css: "",
    });
    if (!t.ok) throw new Error("seed template");
    const templateId = (t.value as { templateId: string }).templateId;

    // Create page in chat — branched.
    const pr = await execute(registry, adapter, cCtx, "pages.create", {
      slug: `${PFX}chain-p1`,
      locale: "en",
      title: "Chain Page",
      templateId,
    });
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    const pageId = (pr.value as { pageId: string }).pageId;

    // SAME chat reads the page back — must succeed (the v0.5.7
    // breakage was that this returned "page not found").
    const gr = await execute(registry, adapter, cCtx, "pages.get", { pageId });
    expect(gr.ok).toBe(true);
    if (!gr.ok) return;

    // Same chat creates a module + attaches it — the full
    // create-then-use chain that v0.5.19 had to revert.
    const mr = await execute(registry, adapter, cCtx, "modules.create", {
      slug: `${PFX}chain-m1`,
      displayName: "Chain M",
      html: "<p>x</p>",
    });
    if (!mr.ok) throw new Error("seed module");
    const moduleId = (mr.value as { moduleId: string }).moduleId;

    const sr = await execute(registry, adapter, cCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    expect(sr.ok).toBe(true);
  });
});
