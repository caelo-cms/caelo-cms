// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for tool calls the real-AI suite (e2e-livedit) filed as
 * "detected bugs": arguments the AI sent on its first try that the tool
 * surface refused, where the AI's shape was the reasonable one.
 *
 *  - set_theme_tokens({tokens: <DTCG document>}) — the document shape every
 *    other theme surface shows; now accepted and written via `set`.
 *  - get_quality_audit({pageId}) — its sibling list_quality_acceptances
 *    takes one; now a per-page filter.
 *  - build_page entries with `position` (carried over from add_module).
 *  - module `html` / `css` wrapped in `<![CDATA[ … ]]>`: every authoring
 *    tool now says the value is plain source text, and decodes a whole-value
 *    envelope instead of refusing it (add_module css, runs 39654716622,
 *    39936064709, 39971619728).
 */

import { describe, expect, it } from "bun:test";
import { moduleUpdateSchema, normalizeTokens } from "@caelo-cms/shared";
import { addModuleTool } from "../add-module.js";
import { buildPageTool } from "../build-page.js";
import { updateModulesManyTool } from "../bulk-pages-modules.js";
import { createLayoutTool } from "../create-layout.js";
import { createTemplateTool } from "../create-template.js";
import { loadSkillTool } from "../load-skill.js";
import { proposeLayoutUpdateTool, proposeTemplateUpdateTool } from "../propose-tools-batch.js";
import { getQualityAuditTool } from "../quality-audit-tools.js";
import { mergeTokenDocumentIntoSet, updateThemeTokensTool } from "../update-theme-tokens.js";

type Props = Record<string, Record<string, unknown>>;

describe("set_theme_tokens accepts a DTCG `tokens` document", () => {
  // Shape taken from the live run's rejected call (stringified JSON).
  const doc = {
    color: {
      primary: { $value: "#4338ca", $description: "Primary brand indigo." },
      "primary-foreground": { $value: "#ffffff" },
    },
    typography: {
      heading: {
        $type: "typography",
        $value: { fontFamily: "Inter, sans-serif", fontSize: "2rem", fontWeight: 700 },
      },
    },
  };

  it("parses the tool input with `tokens` as an object or a JSON string", () => {
    expect(updateThemeTokensTool.schema.safeParse({ tokens: doc }).success).toBe(true);
    expect(updateThemeTokensTool.schema.safeParse({ tokens: JSON.stringify(doc) }).success).toBe(
      true,
    );
  });

  it("turns every leaf into a canonical-path `set` entry the op's normaliser accepts", () => {
    const merged = mergeTokenDocumentIntoSet(JSON.stringify(doc), { radiusMd: "0.5rem" });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(Object.keys(merged.set).sort()).toEqual([
      "color.primary",
      "color.primary-foreground",
      "radiusMd",
      "typography.heading",
    ]);
    const normalized = normalizeTokens(merged.set);
    expect(normalized.set["color.primary"]).toBe("#4338ca");
    expect(normalized.descriptions["color.primary"]).toBe("Primary brand indigo.");
    expect(normalized.canonicalPaths).toContain("typography.heading");
  });

  it("fails loudly on invalid JSON, an empty document and a path given twice", () => {
    const notJson = mergeTokenDocumentIntoSet("{color:", undefined);
    expect(notJson.ok).toBe(false);
    const empty = mergeTokenDocumentIntoSet({ color: {} }, undefined);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain("use `set`");
    const twice = mergeTokenDocumentIntoSet(doc, { "color.primary": "#000000" });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.message).toContain("color.primary");
  });
});

describe("get_quality_audit takes a `pageId` filter", () => {
  it("accepts { pageId } and keeps it out of the op input", () => {
    const pageId = "11111111-1111-4111-8111-111111111111";
    expect(getQualityAuditTool.schema.safeParse({ pageId }).success).toBe(true);
    const props = getQualityAuditTool.inputSchema.properties as Props;
    expect(props.pageId).toBeDefined();
  });
});

describe("build_page exposes `position` per module entry", () => {
  it("lists position in the provider schema with add_module's grammar", () => {
    const modules = (buildPageTool.inputSchema.properties as Props).modules as {
      items: { properties: Props };
    };
    const position = modules.items.properties.position as { oneOf: unknown[] };
    expect(position.oneOf).toEqual(
      (addModuleTool.inputSchema.properties as Props).position?.oneOf as unknown[],
    );
  });
});

describe("module authoring tools say html/css are plain source text (no CDATA)", () => {
  const entryProps = (
    tool: { inputSchema: Record<string, unknown> },
    nested?: "modules" | "items",
  ) => {
    const props = tool.inputSchema.properties as Props;
    if (nested === undefined) return props;
    return (props[nested] as { items: { properties: Props } }).items.properties;
  };
  const cases: [string, Props][] = [
    ["add_module", entryProps(addModuleTool)],
    ["build_page", entryProps(buildPageTool, "modules")],
  ];
  cases.push(["update_modules_many", entryProps(updateModulesManyTool, "items")]);

  for (const [name, props] of cases) {
    it(`${name}: html, css and js descriptions rule out a CDATA wrapper`, () => {
      for (const key of ["html", "css", "js"]) {
        expect(String(props[key]?.description ?? "")).toContain("<![CDATA[");
      }
    });
  }
});

describe("authoring tools decode a whole-value CDATA envelope around source text", () => {
  const css = ".consent-banner {\n  position: fixed;\n}";
  const html = '<div class="consent-banner">{{banner_heading}}</div>';
  const js = "(() => { document.querySelectorAll('.consent-banner'); })();";
  const wrap = (v: string) => `<![CDATA[${v}]]>`;
  const moduleId = "11111111-1111-4111-8111-111111111111";
  const layoutId = "22222222-2222-4222-8222-222222222222";

  type Parse = (input: unknown) => { success: boolean; data?: unknown };
  const parsed = (parse: Parse, input: unknown) => {
    const r = parse(input);
    expect(r.success).toBe(true);
    return r.data as Record<string, unknown>;
  };

  it("add_module (the filed call: html + css both wrapped)", () => {
    const out = parsed((i) => addModuleTool.schema.safeParse(i), {
      target: "layout",
      targetRef: layoutId,
      blockName: "footer",
      position: "bottom",
      displayName: "Cookie-Banner",
      description: "Site-wide consent banner.",
      kind: "utility",
      html: wrap(html),
      css: wrap(css),
      js: wrap(js),
    });
    expect([out.html, out.css, out.js]).toEqual([html, css, js]);
  });

  it("update_modules_many (a css-only item and a full-body item)", () => {
    const bulk = parsed((i) => updateModulesManyTool.schema.safeParse(i), {
      items: [
        { moduleId, css: wrap(css) },
        { moduleId, html: wrap(html), css: wrap(css), js: wrap(js) },
      ],
    });
    const items = bulk.items as Record<string, unknown>[];
    expect(items[0]?.css).toBe(css);
    expect(items[1]).toMatchObject({ html, css, js });
  });

  it("build_page module entries", () => {
    const out = parsed((i) => buildPageTool.schema.safeParse(i), {
      page: { slug: "pricing", title: "Pricing" },
      modules: [
        {
          blockName: "content",
          displayName: "Pricing Hero",
          kind: "hero",
          description: "Pricing page hero.",
          html: wrap("<section>{{hero_title}}</section>"),
          css: wrap(css),
          fields: [{ name: "hero_title", kind: "text", label: "Hero title" }],
          content: { source: "inline", values: { hero_title: "Fair pricing" } },
        },
      ],
    });
    expect((out.modules as Record<string, unknown>[])[0]).toMatchObject({
      html: "<section>{{hero_title}}</section>",
      css,
    });
  });

  it("template and layout authoring (no CDATA refusal downstream, so decoding matters most)", () => {
    const layoutHtml = '<body><caelo-slot name="content"></caelo-slot></body>';
    expect(
      parsed((i) => createLayoutTool.schema.safeParse(i), {
        slug: "main",
        displayName: "Main",
        html: wrap(layoutHtml),
        css: wrap(css),
        blocks: [{ name: "content", displayName: "Content", position: 0 }],
      }).css,
    ).toBe(css);
    expect(
      parsed((i) => createTemplateTool.schema.safeParse(i), {
        slug: "landing",
        displayName: "Landing",
        html: wrap(layoutHtml),
        css: wrap(css),
      }).css,
    ).toBe(css);
    expect(
      parsed((i) => proposeLayoutUpdateTool.schema.safeParse(i), { layoutId, css: wrap(css) }).css,
    ).toBe(css);
    expect(
      parsed((i) => proposeTemplateUpdateTool.schema.safeParse(i), {
        templateId: layoutId,
        css: wrap(css),
      }).css,
    ).toBe(css);
  });

  it("still refuses a CDATA marker that is not a whole-value envelope", () => {
    const guarded = `/*<![CDATA[*/ ${css} /*]]>*/`;
    expect(moduleUpdateSchema.safeParse({ moduleId, css: guarded }).success).toBe(false);
    expect(
      updateModulesManyTool.schema.safeParse({ items: [{ moduleId, css: guarded }] }).success,
    ).toBe(false);
  });
});

describe("load_skill takes every skill a site build engages in one call", () => {
  it("accepts the six-skill load the real-AI suite filed (runs 39924624682, 40018333047)", () => {
    const slugs = [
      "bootstrap-site",
      "compose-page",
      "design-quality",
      "brand-voice-guard",
      "theme-branding",
      "templates-layouts",
    ];
    expect(loadSkillTool.schema.safeParse({ slugs }).success).toBe(true);
    const props = loadSkillTool.inputSchema.properties as Props;
    expect(Number(props.slugs?.maxItems)).toBeGreaterThanOrEqual(slugs.length);
  });
});
