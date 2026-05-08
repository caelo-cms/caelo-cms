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
  it("returns composed HTML + each CSS layer + modules grouped by block", async () => {
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

    // 4. Dispatch the inspect tool.
    const tools = new ToolRegistry();
    tools.register(inspectPageRenderTool);
    const result = await tools.dispatch("inspect_page_render", { pageId }, aiCtx, {
      adapter,
      registry,
    });

    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.content) as {
      page: { slug: string };
      composedHtml: string;
      composedHtmlBytes: number;
      layout: { slug: string; html: string; css: string } | null;
      template: { slug: string; html: string; css: string } | null;
      theme: { tokens: Record<string, string>; tokenCount: number };
      modulesByBlock: {
        blockName: string;
        modules: { slug: string; html: string; css: string }[];
      }[];
      slots: { replaced: string[]; missing: string[] };
    };

    // 5. Assertions on the structured response.
    expect(payload.page.slug).toBe(PAGE_SLUG);

    // Composed HTML carries the module's HTML + each layer's CSS.
    expect(payload.composedHtml).toContain("HELLO_INSPECT");
    expect(payload.composedHtmlBytes).toBe(payload.composedHtml.length);

    // Layout layer is present + carries the original CSS string.
    expect(payload.layout).not.toBeNull();
    expect(payload.layout?.slug).toBe(LAYOUT_SLUG);
    expect(payload.layout?.css).toContain("body{margin:0}");

    // Template layer is present.
    expect(payload.template).not.toBeNull();
    expect(payload.template?.slug).toBe(TPL_SLUG);
    expect(payload.template?.css).toContain("padding:24px");

    // Module layer surfaces the seeded module under "content" block.
    const contentBlock = payload.modulesByBlock.find((b) => b.blockName === "content");
    expect(contentBlock).toBeDefined();
    expect(contentBlock?.modules.length).toBe(1);
    expect(contentBlock?.modules[0]?.slug).toBe(MOD_SLUG);
    expect(contentBlock?.modules[0]?.css).toContain("rebeccapurple");

    // Theme tokens are reachable (may be empty if the install hasn't
    // seeded a theme; we don't fail on that — the key is the field
    // exists and is the right shape).
    expect(typeof payload.theme.tokens).toBe("object");
    expect(typeof payload.theme.tokenCount).toBe("number");

    // Slot bookkeeping is surfaced for sanity.
    expect(Array.isArray(payload.slots.replaced)).toBe(true);
    expect(Array.isArray(payload.slots.missing)).toBe(true);
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
