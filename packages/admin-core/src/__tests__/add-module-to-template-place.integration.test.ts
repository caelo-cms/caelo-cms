// SPDX-License-Identifier: MPL-2.0

/**
 * issue #243 — `add_module_to_template` place-existing path, end-to-end
 * against real Postgres. Seeds a template + two bound pages + one already-
 * existing module, then drives the tool handler in place mode (`moduleId`)
 * and asserts:
 *   - the SAME module lands in the target block on BOTH pages;
 *   - no duplicate module was minted (the reuse invariant — before #243
 *     the AI had to fall back to add_module_to_page, which only worked
 *     when the template had exactly one page).
 *
 * Driven with a `system` actor so the AI cold-start gate is bypassed
 * (the gate only fires for `ai` actors); the handler chain — modules.get,
 * pages.list, pages.get_with_modules, pages.set_modules — is identical.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { addModuleTool } from "../ai/tools/add-module.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue243-place-int",
};

const PFX = "issue243-place";
const TPL_SLUG = `${PFX}-tpl`;
const PAGE_A_SLUG = `${PFX}-page-a`;
const PAGE_B_SLUG = `${PFX}-page-b`;
const MOD_SLUG = `${PFX}-shared`;

interface PageDetail {
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

async function moduleIdsInContent(pageId: string): Promise<string[]> {
  const got = await execute(registry, adapter, SYSTEM, "pages.get_with_modules", { pageId });
  if (!got.ok) throw new Error("get_with_modules");
  const page = (got.value as { page: PageDetail }).page;
  return page.blocks.find((b) => b.blockName === "content")?.modules.map((m) => m.moduleId) ?? [];
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
    });
  } finally {
    await sql.end();
  }
}

let moduleId: string;
let templateId: string;
let pageAId: string;
let pageBId: string;

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL_SLUG,
    displayName: "Place T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl seed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const pgA = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: PAGE_A_SLUG,
    title: "Place P A",
    templateId,
  });
  const pgB = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: PAGE_B_SLUG,
    title: "Place P B",
    templateId,
  });
  if (!pgA.ok || !pgB.ok) throw new Error("page seed");
  pageAId = (pgA.value as { pageId: string }).pageId;
  pageBId = (pgB.value as { pageId: string }).pageId;

  const mod = await execute(registry, adapter, SYSTEM, "modules.create", {
    slug: MOD_SLUG,
    displayName: "Shared post footer",
    html: "<footer>{{copyright}}</footer>",
    fields: [{ name: "copyright", kind: "text", label: "Copyright" } as never],
  });
  if (!mod.ok) throw new Error("module seed");
  moduleId = (mod.value as { moduleId: string }).moduleId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("add_module (target='template') place-existing path (issue #243)", () => {
  it("fans the existing module out to every bound page and mints no duplicate", async () => {
    const toolCtx = { adapter, registry } as ToolContext;
    const res = await addModuleTool.handler(
      SYSTEM,
      {
        target: "template",
        targetRef: templateId,
        blockName: "content",
        position: "bottom",
        moduleId,
      },
      toolCtx,
    );

    expect(res.ok).toBe(true);
    expect(res.content).toContain("existing module");
    expect(res.content).toContain("2 of 2 pages");

    // The shared module now lives in BOTH pages' content block.
    expect(await moduleIdsInContent(pageAId)).toContain(moduleId);
    expect(await moduleIdsInContent(pageBId)).toContain(moduleId);

    // Reuse invariant: exactly one module carries our prefix — the seed.
    // A place call that silently minted a duplicate would show two.
    const list = await execute(registry, adapter, SYSTEM, "modules.list", {});
    if (!list.ok) throw new Error("list");
    const mine = (list.value as { modules: { slug: string }[] }).modules.filter((m) =>
      m.slug.startsWith(PFX),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.slug).toBe(MOD_SLUG);
  });
});
