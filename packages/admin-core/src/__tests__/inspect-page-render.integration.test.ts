// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.69 — `inspect_page_render` AI tool returns the composed HTML
 * + every CSS layer separately so the AI can debug visual issues
 * (the white-padding-around-header dead-end the operator hit).
 *
 * Asserts the tool surfaces:
 *  - composedHtml with the rendered <caelo-slot> filled
 *  - layout (id, slug, html, css)
 *  - template (id, slug, html, css)
 *  - theme.tokens (when seeded)
 *  - modulesByBlock with the seeded module's html + css
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { inspectPageRenderTool } from "../ai/tools/inspect-page-render.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "v0269-inspect",
};
const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "v0269-inspect-ai",
};

const LAYOUT_SLUG = "v0269-inspect-layout";
const TPL_SLUG = "v0269-inspect-tpl";
const MOD_SLUG = "v0269-inspect-mod";
const PAGE_SLUG = "v0269-inspect-page";

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
      await tx`DELETE FROM layout_blocks WHERE layout_id IN (SELECT id FROM layouts WHERE slug = ${LAYOUT_SLUG})`;
      await tx`DELETE FROM layouts WHERE slug = ${LAYOUT_SLUG}`;
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

describe("inspect_page_render tool (v0.2.69)", () => {
  it("returns a slim summary by default, then full bodies via target/search", async () => {
    // 1. Seed a layout with content + header blocks.
    const layoutR = await execute(registry, adapter, systemCtx, "layouts.create", {
      slug: LAYOUT_SLUG,
      displayName: "Inspect Layout",
      html: '<html><head></head><body><header><caelo-slot name="header"></caelo-slot></header><main><caelo-slot name="content"></caelo-slot></main></body></html>',
      css: "body{margin:0}header{background:#fafafa}",
      blocks: [
        { name: "content", displayName: "Content", position: 0 },
        { name: "header", displayName: "Header", position: 1 },
      ],
    });
    if (!layoutR.ok) throw new Error(`layout seed: ${JSON.stringify(layoutR.error)}`);
    const layoutId = (layoutR.value as { layoutId: string }).layoutId;

    // 2. Seed a template bound to the layout, with a content slot.
    const tplR = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TPL_SLUG,
      displayName: "Inspect Template",
      html: '<article class="page"><caelo-slot name="content">_</caelo-slot></article>',
      css: ".page{padding:24px}",
      layoutId,
    });
    if (!tplR.ok) throw new Error(`tpl seed: ${JSON.stringify(tplR.error)}`);
    const templateId = (tplR.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Main content", position: 0 }],
    });

    // 3. Seed a module + page binding into the content block.
    const modR = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "Inspect Module",
      html: '<p class="hello">HELLO_INSPECT</p>',
      css: ".hello{color:rebeccapurple;font-size:24px}",
      js: "",
    });
    if (!modR.ok) throw new Error(`mod seed: ${JSON.stringify(modR.error)}`);
    const moduleId = (modR.value as { moduleId: string }).moduleId;

    const pgR = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "Inspect Page",
      templateId,
    });
    if (!pgR.ok) throw new Error(`page seed: ${JSON.stringify(pgR.error)}`);
    const pageId = (pgR.value as { pageId: string }).pageId;
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });

    const tools = new ToolRegistry();
    tools.register(inspectPageRenderTool);

    // 4. Default dispatch → the SLIM SUMMARY (structure + sizes, NO bodies).
    const sumRes = await tools.dispatch("inspect_page_render", { pageId }, aiCtx, {
      adapter,
      registry,
    });
    expect(sumRes.ok).toBe(true);
    const summary = JSON.parse(sumRes.content) as {
      page: { slug: string };
      composedHtml?: unknown;
      composedHtmlBytes: number;
      layout: { slug: string; htmlBytes: number; cssBytes: number } | null;
      template: { slug: string; htmlBytes: number; cssBytes: number } | null;
      theme: { tokenCount: number };
      modules: {
        moduleId: string;
        slug: string;
        block: string;
        htmlBytes: number;
        cssBytes: number;
      }[];
      slots: { replaced: string[]; missing: string[] };
      hint: string;
    };
    expect(summary.page.slug).toBe(PAGE_SLUG);
    // Sizes, not bodies — the whole point of the slim default.
    expect(summary.composedHtml).toBeUndefined();
    expect(summary.composedHtmlBytes).toBeGreaterThan(0);
    expect(summary.layout?.slug).toBe(LAYOUT_SLUG);
    expect(summary.layout?.cssBytes).toBeGreaterThan(0);
    expect(summary.template?.slug).toBe(TPL_SLUG);
    expect(typeof summary.theme.tokenCount).toBe("number");
    expect(summary.hint).toContain("screenshot_page");
    expect(Array.isArray(summary.slots.replaced)).toBe(true);
    const mod = summary.modules.find((m) => m.slug === MOD_SLUG);
    expect(mod).toBeDefined();
    expect(mod?.block).toBe("content");
    expect(mod?.cssBytes).toBeGreaterThan(0);

    // 5. target:"composed" → the full composed HTML.
    const compRes = await tools.dispatch(
      "inspect_page_render",
      { pageId, target: "composed" },
      aiCtx,
      { adapter, registry },
    );
    expect(compRes.ok).toBe(true);
    expect((JSON.parse(compRes.content) as { composedHtml: string }).composedHtml).toContain(
      "HELLO_INSPECT",
    );

    // 6. target:<moduleId> → that one module's html+css.
    const modRes = await tools.dispatch(
      "inspect_page_render",
      { pageId, target: mod?.moduleId },
      aiCtx,
      { adapter, registry },
    );
    expect(modRes.ok).toBe(true);
    const modPayload = JSON.parse(modRes.content) as { module: { slug: string; css: string } };
    expect(modPayload.module.slug).toBe(MOD_SLUG);
    expect(modPayload.module.css).toContain("rebeccapurple");

    // 6b. target:<moduleId> for a module that is NOT one of the page's block
    //     modules (chrome lives on the layout; reusable modules live off-page).
    //     It must resolve by id via modules.get, not dead-end — with a note.
    const offPage = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: `${MOD_SLUG}-offpage`,
      displayName: "Off-page Module",
      html: '<footer class="chrome">OFFPAGE_BODY</footer>',
      css: ".chrome{color:teal}",
      js: "",
    });
    if (!offPage.ok) throw new Error(`offpage seed: ${JSON.stringify(offPage.error)}`);
    const offPageId = (offPage.value as { moduleId: string }).moduleId;
    const offRes = await tools.dispatch(
      "inspect_page_render",
      { pageId, target: offPageId },
      aiCtx,
      { adapter, registry },
    );
    expect(offRes.ok).toBe(true);
    const offPayload = JSON.parse(offRes.content) as {
      note?: string;
      module: { html: string };
    };
    expect(offPayload.module.html).toContain("OFFPAGE_BODY");
    expect(offPayload.note).toContain("fetched by id");

    // 6c. A truly-nonexistent module id still fails cleanly (no false positive).
    const missRes = await tools.dispatch(
      "inspect_page_render",
      { pageId, target: "11111111-1111-4111-8111-111111111111" },
      aiCtx,
      { adapter, registry },
    );
    expect(missRes.ok).toBe(false);
    expect(missRes.content).toContain("no such id");

    // 7. target:"theme" → the token map (shape only; a fresh install may
    //    have no theme seeded).
    const themeRes = await tools.dispatch(
      "inspect_page_render",
      { pageId, target: "theme" },
      aiCtx,
      { adapter, registry },
    );
    expect(themeRes.ok).toBe(true);
    expect(
      typeof (JSON.parse(themeRes.content) as { theme: { tokens: unknown } }).theme.tokens,
    ).toBe("object");

    // 8. search → only the matching slice of the composed HTML.
    const searchRes = await tools.dispatch(
      "inspect_page_render",
      { pageId, search: "HELLO_INSPECT" },
      aiCtx,
      { adapter, registry },
    );
    expect(searchRes.ok).toBe(true);
    const searchPayload = JSON.parse(searchRes.content) as { composedHtml: string; search: string };
    expect(searchPayload.composedHtml).toContain("HELLO_INSPECT");
    expect(searchPayload.search).toBe("HELLO_INSPECT");
  });

  it("fails cleanly when the page does not exist", async () => {
    const tools = new ToolRegistry();
    tools.register(inspectPageRenderTool);
    const result = await tools.dispatch(
      "inspect_page_render",
      { pageId: "00000000-0000-0000-0000-000000000000" },
      aiCtx,
      { adapter, registry },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("render_preview failed");
  });
});
