// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W1 — describe-state builder + catalogue(state) integration.
 *
 * Three things to lock in:
 *   1. buildToolDescribeState extracts the right shape from
 *      layouts.list / templates.list / site_defaults.get value payloads.
 *   2. catalogue(state) invokes tool.describe(state) when set + falls
 *      back to t.description when describe is absent or throws.
 *   3. The 6 high-value tools' describe() callbacks emit different
 *      strings in fresh-install vs. populated-site states.
 *
 * No DB needed — every assertion is a pure-data round-trip.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { addModuleToLayoutTool } from "../add-module-to-layout.js";
import { addModuleToPageTool } from "../add-module-to-page.js";
import { addModuleToTemplateTool } from "../add-module-to-template.js";
import { bootstrapSiteScaffoldTool } from "../bootstrap-site-scaffold.js";
import { createPageTool } from "../create-page.js";
import { createTemplateTool } from "../create-template.js";
import { buildToolDescribeState, type ToolDescribeState } from "../describe-state.js";
import { type ToolDefinitionWithHandler, ToolRegistry } from "../dispatch.js";
import { setSiteDefaultsTool } from "../set-site-defaults.js";

const FRESH: ToolDescribeState = buildToolDescribeState({
  actor: { actorId: "ai", actorKind: "ai" },
  layoutsValue: { layouts: [] },
  templatesValue: { templates: [] },
  siteDefaultsValue: { defaults: null },
});

const POPULATED: ToolDescribeState = buildToolDescribeState({
  actor: { actorId: "ai", actorKind: "ai" },
  layoutsValue: {
    layouts: [
      {
        id: "00000000-0000-0000-0000-000000000001",
        slug: "site-default",
        displayName: "Site Default",
        blocks: [
          { name: "header", displayName: "Header" },
          { name: "content", displayName: "Content" },
          { name: "footer", displayName: "Footer" },
        ],
      },
    ],
  },
  templatesValue: {
    templates: [
      {
        id: "00000000-0000-0000-0000-000000000010",
        slug: "home-template",
        layoutId: "00000000-0000-0000-0000-000000000001",
      },
      {
        id: "00000000-0000-0000-0000-000000000011",
        slug: "blog-post",
        layoutId: "00000000-0000-0000-0000-000000000001",
      },
    ],
  },
  siteDefaultsValue: {
    defaults: { defaultLayoutSlug: "site-default", defaultTemplateSlug: "home-template" },
  },
});

describe("buildToolDescribeState", () => {
  it("treats fresh install (empty arrays + null defaults) as an explicit state", () => {
    expect(FRESH.layouts).toEqual([]);
    expect(FRESH.templates).toEqual([]);
    expect(FRESH.siteDefaults).toBeNull();
    expect(FRESH.fetchedAt).not.toBeNull();
  });

  it("extracts populated layouts, templates, and defaults verbatim", () => {
    expect(POPULATED.layouts).toHaveLength(1);
    expect(POPULATED.layouts[0]!.slug).toBe("site-default");
    expect(POPULATED.layouts[0]!.blocks.map((b) => b.name)).toEqual([
      "header",
      "content",
      "footer",
    ]);
    expect(POPULATED.templates).toHaveLength(2);
    expect(POPULATED.siteDefaults?.defaultLayoutSlug).toBe("site-default");
  });

  it("returns fetchedAt=null when every fetch was skipped (all-null inputs)", () => {
    const s = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: null,
      templatesValue: null,
      siteDefaultsValue: null,
    });
    expect(s.fetchedAt).toBeNull();
  });

  it("tolerates malformed value payloads without throwing", () => {
    const s = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: { layouts: [{ id: 42, slug: null }] },
      templatesValue: { templates: "not an array" },
      siteDefaultsValue: { defaults: { defaultLayoutSlug: 123 } },
    });
    expect(s.layouts).toEqual([]);
    expect(s.templates).toEqual([]);
    expect(s.siteDefaults).toBeNull();
  });
});

describe("ToolRegistry.catalogue(state)", () => {
  function makeTool(
    name: string,
    description: string,
    describe?: (state: ToolDescribeState) => string,
  ): ToolDefinitionWithHandler<unknown> {
    const def: ToolDefinitionWithHandler<unknown> = {
      name,
      description,
      schema: z.unknown() as z.ZodType<unknown>,
      inputSchema: { type: "object" },
      handler: async () => ({ ok: true, content: "" }),
      ...(describe ? { describe } : {}),
    };
    return def;
  }

  it("uses static description when no state is supplied", () => {
    const r = new ToolRegistry();
    r.register(makeTool("a", "static-a", () => "dynamic-a"));
    const cat = r.catalogue();
    expect(cat[0]!.description).toBe("static-a");
  });

  it("uses describe(state) when both are supplied", () => {
    const r = new ToolRegistry();
    r.register(makeTool("a", "static-a", () => "dynamic-a"));
    const cat = r.catalogue(FRESH);
    expect(cat[0]!.description).toBe("dynamic-a");
  });

  it("falls back to static description when describe() throws", () => {
    const r = new ToolRegistry();
    r.register(
      makeTool("a", "static-a", () => {
        throw new Error("boom");
      }),
    );
    const cat = r.catalogue(FRESH);
    expect(cat[0]!.description).toBe("static-a");
  });

  it("uses static description for tools without describe() even when state is supplied", () => {
    const r = new ToolRegistry();
    r.register(makeTool("a", "static-a"));
    const cat = r.catalogue(FRESH);
    expect(cat[0]!.description).toBe("static-a");
  });
});

describe("describe() callbacks on the 6 high-value tools", () => {
  it("create_template flags layoutId REQUIRED when site_defaults is empty but layouts exist", () => {
    const withLayoutNoDefaults = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: POPULATED.layouts.map((l) => l),
      // populated arr but no defaults
      templatesValue: { templates: [] },
      siteDefaultsValue: { defaults: null },
    });
    // Wrap layouts in {layouts:[...]}
    const s = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: { layouts: POPULATED.layouts.map((l) => l) },
      templatesValue: { templates: [] },
      siteDefaultsValue: { defaults: null },
    });
    expect(s.siteDefaults).toBeNull();
    expect(s.layouts.length).toBeGreaterThan(0);
    const d = createTemplateTool.describe!(s);
    expect(d).toContain("layoutId` is REQUIRED");
    expect(d).toContain("site-default");
    expect(withLayoutNoDefaults.layouts).toEqual([]); // baseline sanity for the type-extraction guards
  });

  it("create_template tells AI to bootstrap when NO layouts exist", () => {
    const d = createTemplateTool.describe!(FRESH);
    expect(d).toContain("NO layouts yet");
    expect(d).toContain("create_layout first");
  });

  it("create_template surfaces the default layout slug when defaults are configured", () => {
    const d = createTemplateTool.describe!(POPULATED);
    expect(d).toContain("site default layout");
    expect(d).toContain("site-default");
  });

  it("create_page tells AI templateId is required when defaults missing but templates exist", () => {
    const s = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: { layouts: POPULATED.layouts.map((l) => l) },
      templatesValue: { templates: POPULATED.templates.map((t) => t) },
      siteDefaultsValue: { defaults: null },
    });
    const d = createPageTool.describe!(s);
    expect(d).toContain("templateId` is REQUIRED");
    expect(d).toContain("home-template");
  });

  it("create_page tells AI to bootstrap when NO templates exist", () => {
    const d = createPageTool.describe!(FRESH);
    expect(d).toContain("NO templates");
    expect(d).toContain("Bootstrap first");
  });

  it("set_site_defaults lists available layout + template slugs", () => {
    const d = setSiteDefaultsTool.describe!(POPULATED);
    expect(d).toContain("Available layout slugs: site-default");
    expect(d).toContain("Available template slugs: home-template, blog-post");
  });

  it("set_site_defaults requires BOTH slugs on first set when defaults is empty", () => {
    const s = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: { layouts: POPULATED.layouts.map((l) => l) },
      templatesValue: { templates: POPULATED.templates.map((t) => t) },
      siteDefaultsValue: { defaults: null },
    });
    const d = setSiteDefaultsTool.describe!(s);
    expect(d).toContain("On first set BOTH");
  });

  it("add_module_to_layout enumerates (layoutSlug, blockName) pairs", () => {
    const d = addModuleToLayoutTool.describe!(POPULATED);
    expect(d).toContain("site-default → blocks: header/content/footer");
  });

  it("add_module_to_layout warns when no layouts exist", () => {
    const d = addModuleToLayoutTool.describe!(FRESH);
    expect(d).toContain("NO layouts exist");
  });

  it("add_module_to_template lists template UUIDs with slugs", () => {
    const d = addModuleToTemplateTool.describe!(POPULATED);
    expect(d).toContain("home-template → templateId=00000000-0000-0000-0000-000000000010");
    expect(d).toContain("blog-post → templateId=00000000-0000-0000-0000-000000000011");
  });

  it("add_module_to_template warns when no templates exist", () => {
    const d = addModuleToTemplateTool.describe!(FRESH);
    expect(d).toContain("NO templates exist");
  });

  it("add_module_to_page warns about fresh-install state without listing every page", () => {
    const dFresh = addModuleToPageTool.describe!(FRESH);
    expect(dFresh).toContain("NO templates");
    const dPop = addModuleToPageTool.describe!(POPULATED);
    expect(dPop).toContain("Pass `pageId`");
    expect(dPop).toContain("position");
  });

  it("bootstrap_site_scaffold STAGE 0 — no layout: describes proposal queue path", () => {
    const d = bootstrapSiteScaffoldTool.describe!(FRESH);
    expect(d).toContain("STAGE 0");
    expect(d).toContain("layouts.create proposal");
    expect(d).toContain("/security/layouts/pending");
  });

  it("bootstrap_site_scaffold STAGE 1 — layout exists, no template", () => {
    const layoutOnly = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: { layouts: POPULATED.layouts.map((l) => l) },
      templatesValue: { templates: [] },
      siteDefaultsValue: { defaults: null },
    });
    const d = bootstrapSiteScaffoldTool.describe!(layoutOnly);
    expect(d).toContain("STAGE 1");
    expect(d).toContain("create a template directly");
  });

  it("bootstrap_site_scaffold STAGE 2 — layout + template, no defaults", () => {
    const noDefaults = buildToolDescribeState({
      actor: { actorId: "ai", actorKind: "ai" },
      layoutsValue: { layouts: POPULATED.layouts.map((l) => l) },
      templatesValue: { templates: POPULATED.templates.map((t) => t) },
      siteDefaultsValue: { defaults: null },
    });
    const d = bootstrapSiteScaffoldTool.describe!(noDefaults);
    expect(d).toContain("STAGE 2");
    expect(d).toContain("pin site_defaults directly");
  });

  it("bootstrap_site_scaffold STAGE 3 — already complete is a no-op", () => {
    const d = bootstrapSiteScaffoldTool.describe!(POPULATED);
    expect(d).toContain("already complete");
    expect(d).toContain("no-op");
  });
});
