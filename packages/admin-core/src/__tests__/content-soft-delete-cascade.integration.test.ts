// SPDX-License-Identifier: MPL-2.0

/**
 * Soft-delete cascade rule (P3 follow-up):
 *   - pages.get_with_modules surfaces deleted modules with isDeleted=true so
 *     the composer can mark them "remove or replace".
 *   - pages.render_preview drops deleted modules entirely so the visitor
 *     never sees a museum of broken refs.
 *   - pages.set_modules continues to reject any attempt to wire a deleted
 *     module into a layout (the read+write rules disagree on rendering only,
 *     not on writing).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "content-cascade-test",
};

const TPL_SLUG = "p3-cascade-tpl";
const MOD_SLUG = "p3-cascade-mod";
const PAGE_SLUG = "p3-cascade-page";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
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

describe("soft-delete cascade", () => {
  it("composer surfaces deleted module with isDeleted=true; preview drops it", async () => {
    // Seed template + slot.
    const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TPL_SLUG,
      displayName: "T",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    });
    if (!tpl.ok) throw new Error("tpl seed");
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    // Seed module + page that uses it.
    const m = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "M",
      html: "<p>VISIBLE</p>",
    });
    if (!m.ok) throw new Error("module seed");
    const moduleId = (m.value as { moduleId: string }).moduleId;

    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "P",
      templateId,
    });
    if (!pg.ok) throw new Error("page seed");
    const pageId = (pg.value as { pageId: string }).pageId;
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });

    // Preview before delete: contains the module HTML.
    const preBefore = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId,
    });
    if (!preBefore.ok) throw new Error("preview pre");
    expect((preBefore.value as { html: string }).html).toContain("VISIBLE");

    // Soft-delete the module.
    const del = await execute(registry, adapter, systemCtx, "modules.delete", { moduleId });
    expect(del.ok).toBe(true);

    // Composer view: row still listed with isDeleted=true.
    const composer = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId,
    });
    expect(composer.ok).toBe(true);
    if (!composer.ok) return;
    const blocks = (
      composer.value as {
        page: { blocks: { modules: { moduleId: string; isDeleted: boolean }[] }[] };
      }
    ).page.blocks;
    const block = blocks.find((b) => b.modules.length > 0);
    expect(block).toBeTruthy();
    expect(block?.modules[0]?.isDeleted).toBe(true);

    // Preview view: module HTML gone, slot renders empty.
    const preAfter = await execute(registry, adapter, systemCtx, "pages.render_preview", {
      pageId,
    });
    if (!preAfter.ok) throw new Error("preview post");
    expect((preAfter.value as { html: string }).html).not.toContain("VISIBLE");

    // Write side: explicit attempt to wire the deleted module is still rejected.
    const reAttempt = await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    expect(reAttempt.ok).toBe(false);
  });
});
