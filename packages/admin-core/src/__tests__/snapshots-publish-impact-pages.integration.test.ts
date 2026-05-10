// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.79 — integration tests for `snapshots.publish_impact_pages`.
 *
 * Seeds two templates (one shared layout), three pages across them,
 * a module attached to two of the pages, then verifies the cascade
 * expansion returns the right pageIds for each kind of edit:
 *   - module change → pages_using_module
 *   - template change → pages_on_template
 *   - layout change → pages_on_templates_using_layout
 *   - structured_set change → fullSite=true
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SUFFIX = "v079-pip";
const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: `${SUFFIX}-test`,
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let layoutAId: string;
let templateAId: string;
let templateBId: string;
let pageA1Id: string;
let pageA2Id: string;
let pageBId: string;
let sharedModuleId: string;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${SUFFIX}%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${SUFFIX}%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${SUFFIX}%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${SUFFIX}%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${SUFFIX}%`}`;
      await tx`DELETE FROM layout_blocks WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE ${`${SUFFIX}%`})`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${SUFFIX}%`}`;
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

  // Layout used by template A.
  const layout = await execute(registry, adapter, SYS, "layouts.create", {
    slug: `${SUFFIX}-layout-a`,
    displayName: "Layout A",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!layout.ok) throw new Error(`layout: ${JSON.stringify(layout.error)}`);
  layoutAId = (layout.value as { layoutId: string }).layoutId;

  const tplA = await execute(registry, adapter, SYS, "templates.create", {
    slug: `${SUFFIX}-tpl-a`,
    displayName: "Template A",
    html: `<div><caelo-slot name="content">_</caelo-slot></div>`,
    layoutId: layoutAId,
  });
  if (!tplA.ok) throw new Error(`tplA: ${JSON.stringify(tplA.error)}`);
  templateAId = (tplA.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYS, "template_blocks.set", {
    templateId: templateAId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const tplB = await execute(registry, adapter, SYS, "templates.create", {
    slug: `${SUFFIX}-tpl-b`,
    displayName: "Template B",
    html: `<section><caelo-slot name="content">_</caelo-slot></section>`,
    layoutId: layoutAId,
  });
  if (!tplB.ok) throw new Error(`tplB: ${JSON.stringify(tplB.error)}`);
  templateBId = (tplB.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYS, "template_blocks.set", {
    templateId: templateBId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const mod = await execute(registry, adapter, SYS, "modules.create", {
    slug: `${SUFFIX}-mod-shared`,
    displayName: "Shared",
    html: "<p>shared</p>",
  });
  if (!mod.ok) throw new Error(`mod: ${JSON.stringify(mod.error)}`);
  sharedModuleId = (mod.value as { moduleId: string }).moduleId;

  const pgA1 = await execute(registry, adapter, SYS, "pages.create", {
    slug: `${SUFFIX}-page-a1`,
    title: "A1",
    templateId: templateAId,
  });
  if (!pgA1.ok) throw new Error(`pgA1: ${JSON.stringify(pgA1.error)}`);
  pageA1Id = (pgA1.value as { pageId: string }).pageId;
  await execute(registry, adapter, SYS, "pages.set_modules", {
    pageId: pageA1Id,
    blocks: [{ blockName: "content", moduleIds: [sharedModuleId] }],
  });

  const pgA2 = await execute(registry, adapter, SYS, "pages.create", {
    slug: `${SUFFIX}-page-a2`,
    title: "A2",
    templateId: templateAId,
  });
  if (!pgA2.ok) throw new Error(`pgA2: ${JSON.stringify(pgA2.error)}`);
  pageA2Id = (pgA2.value as { pageId: string }).pageId;
  await execute(registry, adapter, SYS, "pages.set_modules", {
    pageId: pageA2Id,
    blocks: [{ blockName: "content", moduleIds: [sharedModuleId] }],
  });

  const pgB = await execute(registry, adapter, SYS, "pages.create", {
    slug: `${SUFFIX}-page-b`,
    title: "B",
    templateId: templateBId,
  });
  if (!pgB.ok) throw new Error(`pgB: ${JSON.stringify(pgB.error)}`);
  pageBId = (pgB.value as { pageId: string }).pageId;
  // pageB does NOT use the shared module.
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("snapshots.publish_impact_pages", () => {
  it("expands a module change to all pages using it", async () => {
    const r = await execute(registry, adapter, SYS, "snapshots.publish_impact_pages", {
      moduleIds: [sharedModuleId],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      pageIds: string[];
      fullSite: boolean;
      breakdown: { fromModules: number };
    };
    expect(v.fullSite).toBe(false);
    expect(new Set(v.pageIds)).toEqual(new Set([pageA1Id, pageA2Id]));
    expect(v.breakdown.fromModules).toBeGreaterThanOrEqual(2);
  });

  it("expands a template change to all pages on that template", async () => {
    const r = await execute(registry, adapter, SYS, "snapshots.publish_impact_pages", {
      templateIds: [templateBId],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { pageIds: string[]; fullSite: boolean };
    expect(v.fullSite).toBe(false);
    expect(new Set(v.pageIds)).toEqual(new Set([pageBId]));
  });

  it("expands a layout change to all pages whose template uses that layout", async () => {
    const r = await execute(registry, adapter, SYS, "snapshots.publish_impact_pages", {
      layoutIds: [layoutAId],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { pageIds: string[]; fullSite: boolean };
    expect(v.fullSite).toBe(false);
    // Both templates A + B bind to layoutA → all 3 pages.
    expect(new Set(v.pageIds)).toEqual(new Set([pageA1Id, pageA2Id, pageBId]));
  });

  it("returns fullSite=true when any structured_set is in scope", async () => {
    const r = await execute(registry, adapter, SYS, "snapshots.publish_impact_pages", {
      structuredSetSlugs: ["header-main"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { pageIds: string[]; fullSite: boolean };
    expect(v.fullSite).toBe(true);
    expect(v.pageIds).toEqual([]);
  });

  it("returns empty + fullSite=false when nothing is touched", async () => {
    const r = await execute(registry, adapter, SYS, "snapshots.publish_impact_pages", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { pageIds: string[]; fullSite: boolean };
    expect(v.fullSite).toBe(false);
    expect(v.pageIds).toEqual([]);
  });

  it("dedupes pages reached via multiple cascades", async () => {
    // Module change AND template change touching pageA1 → only one entry.
    const r = await execute(registry, adapter, SYS, "snapshots.publish_impact_pages", {
      moduleIds: [sharedModuleId],
      templateIds: [templateAId],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { pageIds: string[] };
    const counts = new Map<string, number>();
    for (const id of v.pageIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
    expect(new Set(v.pageIds)).toEqual(new Set([pageA1Id, pageA2Id]));
  });
});
