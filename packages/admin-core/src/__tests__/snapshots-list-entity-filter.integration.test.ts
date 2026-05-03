// SPDX-License-Identifier: MPL-2.0

/**
 * snapshots.list with forModuleId / forPageId / forTemplateId filters —
 * powers the per-entity history routes (/content/modules/[id]/history,
 * /content/pages/[id]/history). Verifies the filter excludes unrelated
 * snapshots and includes both the page-metadata and the page-layout
 * snapshots when forPageId is set.
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

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "snapshots-list-filter-test",
};

const TPL_SLUG = "p4-listfilter-tpl";
const MOD_A = "p4-listfilter-mod-a";
const MOD_B = "p4-listfilter-mod-b";
const PAGE_SLUG = "p4-listfilter-page";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug IN (${MOD_A}, ${MOD_B})`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let modAId = "";
let modBId = "";
let pageId = "";
let templateId = "";

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, ctx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "T",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error("tpl");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, ctx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const a = await execute(registry, adapter, ctx, "modules.create", {
    slug: MOD_A,
    displayName: "A",
    html: "<p>a-v1</p>",
  });
  if (!a.ok) throw new Error("a");
  modAId = (a.value as { moduleId: string }).moduleId;
  // 2 more updates to module A — three module_snapshots total.
  await execute(registry, adapter, ctx, "modules.update", {
    moduleId: modAId,
    html: "<p>a-v2</p>",
  });
  await execute(registry, adapter, ctx, "modules.update", {
    moduleId: modAId,
    html: "<p>a-v3</p>",
  });

  const b = await execute(registry, adapter, ctx, "modules.create", {
    slug: MOD_B,
    displayName: "B",
    html: "<p>b-v1</p>",
  });
  if (!b.ok) throw new Error("b");
  modBId = (b.value as { moduleId: string }).moduleId;

  // Page that uses module A — produces a page_snapshots + later a page_layout_snapshots.
  const pg = await execute(registry, adapter, ctx, "pages.create", {
    slug: PAGE_SLUG,
    title: "P",
    templateId,
  });
  if (!pg.ok) throw new Error("page");
  pageId = (pg.value as { pageId: string }).pageId;
  await execute(registry, adapter, ctx, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [modAId] }],
  });
  await execute(registry, adapter, ctx, "pages.update", { pageId, title: "P renamed" });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("snapshots.list per-entity filter", () => {
  it("forModuleId returns only snapshots that touched that module", async () => {
    const r = await execute(registry, adapter, ctx, "snapshots.list", {
      limit: 100,
      forModuleId: modAId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const snaps = (r.value as { snapshots: { description: string }[] }).snapshots;
    // 1 create + 2 updates = 3 entries for A.
    expect(snaps.length).toBe(3);
    expect(snaps.every((s) => s.description.includes(MOD_A))).toBe(true);
  });

  it("forModuleId on B returns the single create snapshot", async () => {
    const r = await execute(registry, adapter, ctx, "snapshots.list", {
      limit: 100,
      forModuleId: modBId,
    });
    if (!r.ok) return;
    const snaps = (r.value as { snapshots: { description: string }[] }).snapshots;
    expect(snaps.length).toBe(1);
    expect(snaps[0]?.description).toContain(MOD_B);
  });

  it("forPageId returns both page_snapshots and page_layout_snapshots entries", async () => {
    const r = await execute(registry, adapter, ctx, "snapshots.list", {
      limit: 100,
      forPageId: pageId,
    });
    if (!r.ok) return;
    const descs = (r.value as { snapshots: { description: string }[] }).snapshots.map(
      (s) => s.description,
    );
    expect(descs.some((d) => d.startsWith("pages.create"))).toBe(true);
    expect(descs.some((d) => d.startsWith("pages.set_modules"))).toBe(true);
    expect(descs.some((d) => d.startsWith("pages.update"))).toBe(true);
  });

  it("forTemplateId returns the template-touching snapshots", async () => {
    const r = await execute(registry, adapter, ctx, "snapshots.list", {
      limit: 100,
      forTemplateId: templateId,
    });
    if (!r.ok) return;
    const descs = (r.value as { snapshots: { description: string }[] }).snapshots.map(
      (s) => s.description,
    );
    // templates.create + template_blocks.set = at least 2.
    expect(descs.some((d) => d.startsWith("templates.create"))).toBe(true);
    expect(descs.some((d) => d.startsWith("template_blocks.set"))).toBe(true);
  });
});
