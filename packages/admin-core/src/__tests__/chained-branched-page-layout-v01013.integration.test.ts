// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.13 — Chained branched edits to a page's module placements
 * compose without losing each other.
 *
 * Pre-v0.10.13 `pages.set_modules` in branched mode emitted a
 * `page_layout_snapshot` and skipped the live `page_modules` write.
 * `pages.get_with_modules` then read live `page_modules` directly,
 * missing the just-written snapshot. The AI's chain
 * (add_module_to_page → reorder_module / move_module) failed with
 * "module X is not on page Y" — the reorder tool's
 * `pages.get_with_modules` read returned the pre-add layout.
 *
 * v0.10.13 fixed the read side via `loadPageLayoutStateWithBranchOverlay`
 * — preferring the latest `page_layout_snapshot` for this page+branch
 * over live `page_modules`. This test exercises the chain.
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

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "v01013-layout",
};

const TPL_SLUG = "v01013-layout-tpl";
const PAGE_SLUG = "v01013-layout-pg";
const MOD1_SLUG = "v01013-layout-m1";
const MOD2_SLUG = "v01013-layout-m2";
const SESSION_TITLE = "v01013-layout-session";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'v01013-layout-%'`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug IN (${MOD1_SLUG}, ${MOD2_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
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

describe("v0.10.13 branched page-layout overlay", () => {
  it("pages.get_with_modules returns the latest branched layout snapshot, not stale live state", async () => {
    // Seed: template + page (initially empty layout).
    const tpl = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: TPL_SLUG,
      displayName: "T",
      html: "<main>{{content}}</main>",
      css: "",
    });
    if (!tpl.ok) throw new Error("tpl");
    const templateId = (tpl.value as { templateId: string }).templateId;

    const page = await execute(registry, adapter, HUMAN, "pages.create", {
      slug: PAGE_SLUG,
      locale: "en",
      title: "P",
      templateId,
      status: "draft",
    });
    if (!page.ok) throw new Error("page");
    const pageId = (page.value as { pageId: string }).pageId;

    const mod1 = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: MOD1_SLUG,
      displayName: "M1",
      html: "<div>one</div>",
    });
    const mod2 = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: MOD2_SLUG,
      displayName: "M2",
      html: "<div>two</div>",
    });
    if (!mod1.ok || !mod2.ok) throw new Error("mods");
    const m1 = (mod1.value as { moduleId: string }).moduleId;
    const m2 = (mod2.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: SESSION_TITLE,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "v01013-layout-ai",
      chatBranchId,
    };

    // Edit 1: branched-attach m1 to the page's content block.
    const e1 = await execute(registry, adapter, aiCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [m1] }],
    });
    expect(e1.ok).toBe(true);

    // Read back via pages.get_with_modules on the same branch.
    // Pre-v0.10.13 this read live `page_modules` (still empty) and
    // returned no blocks; v0.10.13 returns the branched snapshot's
    // layout with m1 attached.
    const r1 = await execute(registry, adapter, aiCtx, "pages.get_with_modules", { pageId });
    if (!r1.ok) throw new Error(`get_with_modules r1: ${JSON.stringify(r1.error)}`);
    const r1Page = (
      r1.value as { page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] } }
    ).page;
    const r1Content = r1Page.blocks.find((b) => b.blockName === "content");
    expect(r1Content?.modules.map((m) => m.moduleId)).toEqual([m1]);

    // Edit 2: branched-attach m2 alongside m1 (the chained edit).
    // Pre-v0.10.13 this required the AI tool to first call
    // get_with_modules to see m1, then send [m1, m2] back in. Since
    // get_with_modules didn't see m1, the AI sent [m2] and lost m1.
    const e2 = await execute(registry, adapter, aiCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [m1, m2] }],
    });
    expect(e2.ok).toBe(true);

    const r2 = await execute(registry, adapter, aiCtx, "pages.get_with_modules", { pageId });
    if (!r2.ok) throw new Error(`get_with_modules r2: ${JSON.stringify(r2.error)}`);
    const r2Page = (
      r2.value as { page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] } }
    ).page;
    const r2Content = r2Page.blocks.find((b) => b.blockName === "content");
    expect(r2Content?.modules.map((m) => m.moduleId)).toEqual([m1, m2]);

    // Merge to main — live page_modules must now contain both modules
    // in the right order, sourced from the latest branched snapshot.
    const merge = await execute(registry, adapter, HUMAN, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merge.ok).toBe(true);

    const sql = new SQL(ADMIN_URL as string);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const live = (await tx`
          SELECT block_name, position, module_id::text AS module_id
          FROM page_modules WHERE page_id = ${pageId}::uuid
          ORDER BY block_name, position
        `) as unknown as { block_name: string; position: number; module_id: string }[];
        expect(live.map((r) => r.module_id)).toEqual([m1, m2]);
        expect(live.every((r) => r.block_name === "content")).toBe(true);
      });
    } finally {
      await sql.end();
    }
  });
});
