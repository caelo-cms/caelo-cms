// SPDX-License-Identifier: MPL-2.0

/**
 * `remove_module_from` — the ONE module-removal tool routed by `target`
 * (page | layout), folding the former remove_module_from_page /
 * remove_module_from_layout. Real Postgres (§6). Covers both targets, slug +
 * uuid targetRef resolution, the "not attached" failure, and the invariant
 * that removal does NOT delete the module row.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { removeModuleFromTool } from "../ai/tools/remove-module-from.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "rmmod-int",
};

const PFX = "rmmod";
let templateId: string;
let layoutId: string;
let layoutSlug: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function makeModule(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "modules.create", {
    slug,
    displayName: `M ${slug}`,
    html: "<div>{{body}}</div>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  if (!r.ok) throw new Error(`module ${slug}`);
  return (r.value as { moduleId: string }).moduleId;
}

async function makePage(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug,
    title: slug,
    templateId,
  });
  if (!r.ok) throw new Error(`page ${slug}`);
  return (r.value as { pageId: string }).pageId;
}

async function pageContentModuleIds(pageId: string): Promise<string[]> {
  const r = await execute(registry, adapter, SYSTEM, "pages.get_with_modules", { pageId });
  if (!r.ok) throw new Error("get_with_modules");
  const page = r.value as {
    page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] };
  };
  return (
    page.page.blocks.find((b) => b.blockName === "content")?.modules.map((m) => m.moduleId) ?? []
  );
}

async function moduleExists(moduleId: string): Promise<boolean> {
  const r = await execute(registry, adapter, SYSTEM, "modules.get", { moduleId });
  return r.ok;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
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

  layoutSlug = `${PFX}-layout`;
  const lay = await execute(registry, adapter, SYSTEM, "layouts.create", {
    slug: layoutSlug,
    displayName: "L",
    html: `<!doctype html><html><head><title>L</title></head><body><header><caelo-slot name="header">_</caelo-slot></header><caelo-slot name="content">_</caelo-slot><footer><caelo-slot name="footer">_</caelo-slot></footer></body></html>`,
    css: "",
    blocks: [
      { name: "header", displayName: "Header", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
      { name: "footer", displayName: "Footer", position: 2 },
    ],
  });
  if (!lay.ok) throw new Error("layout seed");
  layoutId = (lay.value as { layoutId: string }).layoutId;

  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
    layoutId,
  });
  if (!tpl.ok) throw new Error("tpl seed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("remove_module_from — target='page'", () => {
  it("removes the page reference (by page slug) but keeps the module row", async () => {
    const modId = await makeModule(`${PFX}-pmod`);
    const pageId = await makePage(`${PFX}-page`);
    await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [modId] }],
    });
    expect(await pageContentModuleIds(pageId)).toContain(modId);

    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "page", targetRef: `${PFX}-page`, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await pageContentModuleIds(pageId)).not.toContain(modId);
    // The module row survives — removal is detach, not delete.
    expect(await moduleExists(modId)).toBe(true);
  });

  it("also resolves the page by uuid", async () => {
    const modId = await makeModule(`${PFX}-pmod2`);
    const pageId = await makePage(`${PFX}-page2`);
    await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [modId] }],
    });
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "page", targetRef: pageId, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await pageContentModuleIds(pageId)).not.toContain(modId);
  });

  it("fails when the module isn't on the page", async () => {
    const pageId = await makePage(`${PFX}-page3`);
    const other = await makeModule(`${PFX}-notthere`);
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "page", targetRef: pageId, moduleId: other },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
  });
});

describe("remove_module_from — target='layout'", () => {
  it("detaches from the layout block (by layout slug), module row survives", async () => {
    const modId = await makeModule(`${PFX}-lmod`);
    const set = await execute(registry, adapter, SYSTEM, "layout_modules.set", {
      layoutId,
      blockName: "footer",
      moduleIds: [modId],
    });
    expect(set.ok).toBe(true);

    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "layout", targetRef: layoutSlug, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("detached");

    const after = await execute(registry, adapter, SYSTEM, "layout_modules.get", {
      layoutId,
      blockName: "footer",
    });
    if (!after.ok) throw new Error("layout_modules.get");
    expect((after.value as { moduleIds: string[] }).moduleIds).not.toContain(modId);
    expect(await moduleExists(modId)).toBe(true);
  });

  it("also resolves the layout by uuid", async () => {
    const modId = await makeModule(`${PFX}-lmod2`);
    await execute(registry, adapter, SYSTEM, "layout_modules.set", {
      layoutId,
      blockName: "header",
      moduleIds: [modId],
    });
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "layout", targetRef: layoutId, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it("fails when the module isn't attached to the layout", async () => {
    const modId = await makeModule(`${PFX}-lmodx`);
    const r = await removeModuleFromTool.handler(
      SYSTEM,
      { target: "layout", targetRef: layoutSlug, moduleId: modId },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
  });
});
