// SPDX-License-Identifier: MPL-2.0

/**
 * #1076 real-AI gate — a fresh-site chat read list_layouts
 * (`header|content|footer`) and list_templates (no blocks), then sent the
 * header as a build_page entry with blockName 'header' and was refused
 * ("block 'header' does not exist on this page's template"). The only
 * block list it had seen was the LAYOUT's. Every surface the AI reads
 * before its first build_page now names the page blocks and says header /
 * footer are layout chrome. Stub ops, same harness as
 * list-plugins-discovery.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { blockPlacementGuide, chromeBlockNames } from "../_block-roles.js";
import { bootstrapSiteScaffoldTool } from "../bootstrap-site-scaffold.js";
import type { ToolContext } from "../dispatch.js";
import { listLayoutsTool } from "../list-layouts.js";
import { listTemplatesTool } from "../list-templates.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "block-roles-surfaces-test",
};

const LAYOUT_ID = "c1476fff-8ffd-4bf4-afe4-2f62d3302c31";
const TEMPLATE_ID = "3b38f6c5-1cc6-4111-b7a2-164fccdf1300";

const LAYOUTS = [
  {
    id: "cdd2b915-5430-415f-a483-6fb0d5d2cd31",
    slug: "bare",
    displayName: "Bare (no chrome)",
    blocks: [{ name: "content" }],
  },
  {
    id: LAYOUT_ID,
    slug: "site-default",
    displayName: "Site default (header + content + footer)",
    blocks: [{ name: "header" }, { name: "content" }, { name: "footer" }],
  },
];
const TEMPLATES = [
  {
    id: TEMPLATE_ID,
    slug: "home-template",
    displayName: "Home (default)",
    layoutId: LAYOUT_ID,
    blocks: [{ name: "content" }],
    pageTypes: ["page"],
  },
];

function harness(values: Record<string, unknown>): ToolContext {
  const registry = new OperationRegistry();
  for (const [name, value] of Object.entries(values)) {
    registry.register(
      defineOperation({
        name,
        actorScope: ["human", "ai", "system"],
        database: "cms_admin",
        input: z.any(),
        output: z.any(),
        handler: async () => ok(value) as never,
      }),
    );
  }
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("block roles — page blocks vs layout chrome (#1076)", () => {
  it("chromeBlockNames drops the template render target", () => {
    expect(chromeBlockNames(LAYOUTS[1]?.blocks ?? [])).toEqual(["header", "footer"]);
  });

  it("blockPlacementGuide names the page blocks and routes chrome to the layout", () => {
    const text = blockPlacementGuide(
      { slug: "home-template", blocks: [{ name: "content" }] },
      { slug: "site-default", blocks: LAYOUTS[1]?.blocks ?? [] },
    );
    expect(text).toContain("'content' — the ONLY valid build_page blockName values");
    expect(text).toContain("'header', 'footer' are site chrome on layout site-default");
    expect(text).toContain("add_module({target:'layout', targetRef:'site-default'");
    expect(text).toContain("never as a build_page entry");
  });

  it("list_templates shows each template's page blocks", async () => {
    const r = await listTemplatesTool.handler(
      AI,
      { includeDeleted: false } as never,
      harness({ "templates.list": { templates: TEMPLATES } }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("{slug,id,displayName,layoutId,pageBlocks,pageTypes}");
    // Epic #1107 — the page types whose pages may use the template.
    expect(r.content).toContain(
      `home-template,${TEMPLATE_ID},Home (default),${LAYOUT_ID},content,page`,
    );
    expect(listTemplatesTool.description).toContain("ONLY valid `blockName` values for build_page");
    expect(listTemplatesTool.description).toContain("site chrome on the template's LAYOUT");
  });

  it("list_layouts labels its blocks as layout blocks, not build_page blocks", async () => {
    const r = await listLayoutsTool.handler(
      AI,
      { includeDeleted: false } as never,
      harness({ "layouts.list": { layouts: LAYOUTS } }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("{slug,id,displayName,layoutBlocks(modules)}");
    expect(r.content).toContain("header|content|footer");
    expect(listLayoutsTool.description).toContain("NOT build_page blockNames");
    expect(listLayoutsTool.description).not.toContain("context block");
  });

  it("bootstrap_site_scaffold's no-op result names the real defaults and the block roles", async () => {
    const r = await bootstrapSiteScaffoldTool.handler(
      AI,
      {} as never,
      harness({
        "layouts.list": { layouts: LAYOUTS },
        "templates.list": { templates: TEMPLATES },
        "site_defaults.get": {
          defaults: { defaultLayoutId: LAYOUT_ID, defaultTemplateId: TEMPLATE_ID },
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("layout=site-default, template=home-template");
    expect(r.content).toContain("'content' — the ONLY valid build_page blockName values");
    expect(r.content).toContain("'header', 'footer' are site chrome on layout site-default");
  });

  it("bootstrap_site_scaffold refuses loudly when the defaults point at a missing row", async () => {
    const r = await bootstrapSiteScaffoldTool.handler(
      AI,
      {} as never,
      harness({
        "layouts.list": { layouts: LAYOUTS },
        "templates.list": { templates: TEMPLATES },
        "site_defaults.get": {
          defaults: {
            defaultLayoutId: LAYOUT_ID,
            defaultTemplateId: "00000000-0000-0000-0000-000000000000",
          },
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("set_site_defaults");
  });
});
