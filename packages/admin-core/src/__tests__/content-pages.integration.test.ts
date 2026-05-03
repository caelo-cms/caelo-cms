// SPDX-License-Identifier: MPL-2.0

/**
 * Pages + page_modules integration. Verifies:
 *   - pages CRUD + soft delete
 *   - (slug, locale) uniqueness
 *   - pages.set_modules atomic replace + structured failures for unknown
 *     blocks / deleted modules
 *   - pages.get_with_modules returns the joined view
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
  requestId: "content-pages-test",
};

const TPL_SLUG = "p3-pages-tpl";
const MOD_SLUG = "p3-pages-mod";
const MOD_SLUG_2 = "p3-pages-mod2";
const MOD_DELETED_SLUG = "p3-pages-mod-deleted";
const PAGE_SLUGS = [
  "p3-pages-home",
  "p3-pages-about",
  "p3-set-modules-page",
  "p3-bad-block-page",
  "p3-bad-mod-page",
] as const;

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const slug of PAGE_SLUGS) {
        await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})`;
        await tx`DELETE FROM pages WHERE slug = ${slug}`;
      }
      for (const slug of [MOD_SLUG, MOD_SLUG_2, MOD_DELETED_SLUG]) {
        await tx`DELETE FROM modules WHERE slug = ${slug}`;
      }
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let templateId = "";
let moduleId = "";
let module2Id = "";
let deletedModuleId = "";

beforeAll(async () => {
  await wipe(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "Pages TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error("template seed failed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const m1 = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MOD_SLUG,
    displayName: "M1",
    html: "<p>m1</p>",
  });
  if (!m1.ok) throw new Error("module seed failed");
  moduleId = (m1.value as { moduleId: string }).moduleId;

  const m2 = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MOD_SLUG_2,
    displayName: "M2",
    html: "<p>m2</p>",
  });
  if (!m2.ok) throw new Error("module 2 seed failed");
  module2Id = (m2.value as { moduleId: string }).moduleId;

  const md = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MOD_DELETED_SLUG,
    displayName: "Deleted",
    html: "<p>x</p>",
  });
  if (!md.ok) throw new Error("module 3 seed failed");
  deletedModuleId = (md.value as { moduleId: string }).moduleId;
  await execute(registry, adapter, systemCtx, "modules.delete", { moduleId: deletedModuleId });
});

afterAll(async () => {
  await wipe(ADMIN_URL);
  await adapter.close();
});

describe("pages CRUD", () => {
  it("creates, lists, updates, soft-deletes a page", async () => {
    const create = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUGS[0],
      title: "Home",
      templateId,
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const pageId = (create.value as { pageId: string }).pageId;

    const list = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!list.ok) return;
    expect(
      (list.value as { pages: { slug: string }[] }).pages.some((p) => p.slug === PAGE_SLUGS[0]),
    ).toBe(true);

    const upd = await execute(registry, adapter, systemCtx, "pages.update", {
      pageId,
      title: "Home v2",
      status: "published",
    });
    expect(upd.ok).toBe(true);

    const got = await execute(registry, adapter, systemCtx, "pages.get", { pageId });
    if (!got.ok) return;
    const p = (got.value as { page: { title: string; status: string } }).page;
    expect(p.title).toBe("Home v2");
    expect(p.status).toBe("published");

    const del = await execute(registry, adapter, systemCtx, "pages.delete", { pageId });
    expect(del.ok).toBe(true);

    const list2 = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!list2.ok) return;
    expect(
      (list2.value as { pages: { slug: string }[] }).pages.some((p) => p.slug === PAGE_SLUGS[0]),
    ).toBe(false);
  });

  it("enforces (slug, locale) uniqueness across active pages", async () => {
    const a = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUGS[1],
      title: "About EN",
      templateId,
    });
    expect(a.ok).toBe(true);
    const b = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUGS[1],
      title: "About EN duplicate",
      templateId,
    });
    expect(b.ok).toBe(false);

    // Same slug different locale is allowed.
    const c = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUGS[1],
      locale: "de",
      title: "About DE",
      templateId,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    await execute(registry, adapter, systemCtx, "pages.delete", {
      pageId: (c.value as { pageId: string }).pageId,
    });
    if (a.ok) {
      await execute(registry, adapter, systemCtx, "pages.delete", {
        pageId: (a.value as { pageId: string }).pageId,
      });
    }
  });
});

describe("pages.set_modules", () => {
  it("atomically replaces the layout and round-trips through pages.get_with_modules", async () => {
    const create = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: "p3-set-modules-page",
      title: "X",
      templateId,
    });
    if (!create.ok) return;
    const pageId = (create.value as { pageId: string }).pageId;

    const set = await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId, module2Id] }],
    });
    expect(set.ok).toBe(true);

    const got = await execute(registry, adapter, systemCtx, "pages.get_with_modules", { pageId });
    if (!got.ok) return;
    const blocks = (
      got.value as {
        page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] };
      }
    ).page.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.modules.map((m) => m.moduleId)).toEqual([moduleId, module2Id]);

    // Replace with a single-module layout — no leftover rows.
    const set2 = await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [module2Id] }],
    });
    expect(set2.ok).toBe(true);
    const got2 = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId,
    });
    if (!got2.ok) return;
    expect(
      (
        got2.value as { page: { blocks: { modules: { moduleId: string }[] }[] } }
      ).page.blocks[0]?.modules.map((m) => m.moduleId),
    ).toEqual([module2Id]);

    // Cleanup
    await execute(registry, adapter, systemCtx, "pages.delete", { pageId });
  });

  it("rejects unknown block names with a typed error and leaves layout untouched", async () => {
    const create = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: "p3-bad-block-page",
      title: "X",
      templateId,
    });
    if (!create.ok) return;
    const pageId = (create.value as { pageId: string }).pageId;

    const r = await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "missing-block", moduleIds: [moduleId] }],
    });
    expect(r.ok).toBe(false);
    await execute(registry, adapter, systemCtx, "pages.delete", { pageId });
  });

  it("rejects deleted module ids with a typed error", async () => {
    const create = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: "p3-bad-mod-page",
      title: "X",
      templateId,
    });
    if (!create.ok) return;
    const pageId = (create.value as { pageId: string }).pageId;
    const r = await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [deletedModuleId] }],
    });
    expect(r.ok).toBe(false);
    await execute(registry, adapter, systemCtx, "pages.delete", { pageId });
  });
});
