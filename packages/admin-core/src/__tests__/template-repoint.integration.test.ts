// SPDX-License-Identifier: MPL-2.0

/**
 * Two template-adjacency tools that had no dedicated test:
 *
 *   - repoint_page_template (audit #B rename of change_template) — re-points a
 *     PAGE to a different template; modules in matching block names migrate,
 *     orphans drop/relocate per orphanDisposition.
 *   - set_template_layout — re-points a TEMPLATE to a different layout; every
 *     page on the template adopts the new chrome. Deliberately AI-allowed (the
 *     one narrow layout write the AI keeps, distinct from templates.update).
 *
 * Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { repointPageTemplateTool } from "../ai/tools/repoint-page-template.js";
import { setTemplateLayoutTool } from "../ai/tools/set-template-layout.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "repoint-int",
};
const AI: ExecutionContext = { ...SYSTEM, actorKind: "ai", requestId: "repoint-int-ai" };

const PFX = "repoint";
const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function makeLayout(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "layouts.create", {
    slug,
    displayName: slug,
    html: `<!doctype html><html><head><title>L</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!r.ok) throw new Error(`layout ${slug}`);
  return (r.value as { layoutId: string }).layoutId;
}

/** Create a template with the given block names, bound to `layoutId`. */
async function makeTemplate(slug: string, blocks: string[], layoutId: string): Promise<string> {
  const slots = blocks.map((b) => `<caelo-slot name="${b}">_</caelo-slot>`).join("");
  const r = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug,
    displayName: slug,
    html: `<!doctype html><html><head><title>T</title></head><body>${slots}</body></html>`,
    css: "",
    layoutId,
  });
  if (!r.ok) throw new Error(`tpl ${slug}: ${JSON.stringify(r.error)}`);
  const id = (r.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId: id,
    blocks: blocks.map((name, i) => ({ name, displayName: name, position: i })),
  });
  return id;
}

async function makeModule(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "modules.create", {
    slug,
    displayName: slug,
    html: "<div>{{body}}</div>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  if (!r.ok) throw new Error(`module ${slug}`);
  return (r.value as { moduleId: string }).moduleId;
}

async function templateIdOfPage(pageId: string): Promise<string> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT template_id::text AS id FROM pages WHERE id = ${pageId}::uuid
      `) as unknown as { id: string }[];
      return rows[0]?.id ?? "";
    });
  } finally {
    await sql.end();
  }
}

async function layoutIdOfTemplate(templateId: string): Promise<string> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT layout_id::text AS id FROM templates WHERE id = ${templateId}::uuid
      `) as unknown as { id: string }[];
      return rows[0]?.id ?? "";
    });
  } finally {
    await sql.end();
  }
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
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
    });
  } finally {
    await sql.end();
  }
}

let layout1: string;
let layout2: string;

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  layout1 = await makeLayout(`${PFX}-l1`);
  layout2 = await makeLayout(`${PFX}-l2`);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("repoint_page_template", () => {
  it("re-points a page to a new template; matching-block modules migrate", async () => {
    const tA = await makeTemplate(`${PFX}-ta`, ["content"], layout1);
    const tB = await makeTemplate(`${PFX}-tb`, ["content"], layout1);
    const pg = await execute(registry, adapter, SYSTEM, "pages.create", {
      slug: `${PFX}-pg`,
      title: "P",
      templateId: tA,
    });
    if (!pg.ok) throw new Error("page");
    const pageId = (pg.value as { pageId: string }).pageId;
    const mod = await makeModule(`${PFX}-m`);
    await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [mod] }],
    });

    // orphanDisposition is defaulted by the tool's Zod at dispatch; calling
    // .handler() directly bypasses that, so pass it explicitly (nothing orphans
    // here — content→content — so the value is immaterial).
    const r = await repointPageTemplateTool.handler(
      SYSTEM,
      { pageId, newTemplateId: tB, orphanDisposition: { kind: "drop" } },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await templateIdOfPage(pageId)).toBe(tB);
    // The module in the shared "content" block migrated.
    const got = await execute(registry, adapter, SYSTEM, "pages.get_with_modules", { pageId });
    if (!got.ok) throw new Error("get");
    const blocks = (
      got.value as { page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] } }
    ).page.blocks;
    expect(blocks.find((b) => b.blockName === "content")?.modules.map((m) => m.moduleId)).toContain(
      mod,
    );
  });

  it("drops modules whose block has no match under orphanDisposition {kind:'drop'}", async () => {
    // tA has an extra "sidebar" block; tB does not → the sidebar module orphans.
    const tA = await makeTemplate(`${PFX}-oa`, ["content", "sidebar"], layout1);
    const tB = await makeTemplate(`${PFX}-ob`, ["content"], layout1);
    const pg = await execute(registry, adapter, SYSTEM, "pages.create", {
      slug: `${PFX}-opg`,
      title: "P",
      templateId: tA,
    });
    if (!pg.ok) throw new Error("page");
    const pageId = (pg.value as { pageId: string }).pageId;
    const sideMod = await makeModule(`${PFX}-side`);
    await execute(registry, adapter, SYSTEM, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "sidebar", moduleIds: [sideMod] }],
    });

    const r = await repointPageTemplateTool.handler(
      SYSTEM,
      { pageId, newTemplateId: tB, orphanDisposition: { kind: "drop" } },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("dropped");
    expect(await templateIdOfPage(pageId)).toBe(tB);
  });
});

describe("set_template_layout", () => {
  it("re-points a template to a different layout", async () => {
    const tpl = await makeTemplate(`${PFX}-slt`, ["content"], layout1);
    expect(await layoutIdOfTemplate(tpl)).toBe(layout1);

    const r = await setTemplateLayoutTool.handler(
      SYSTEM,
      { templateId: tpl, layoutSlug: `${PFX}-l2` },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await layoutIdOfTemplate(tpl)).toBe(layout2);
  });

  it("is AI-allowed (the deliberately-narrow layout write)", async () => {
    const tpl = await makeTemplate(`${PFX}-slt2`, ["content"], layout1);
    const r = await setTemplateLayoutTool.handler(
      AI,
      { templateId: tpl, layoutSlug: `${PFX}-l2` },
      toolCtx(),
    );
    // No ActorScopeRejected — the op is ["human","ai","system"] by design.
    expect(r.ok).toBe(true);
    expect(await layoutIdOfTemplate(tpl)).toBe(layout2);
  });
});
