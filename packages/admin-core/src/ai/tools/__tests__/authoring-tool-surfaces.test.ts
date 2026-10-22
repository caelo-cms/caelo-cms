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
 *    tool now says the value is plain source text.
 */

import { describe, expect, it } from "bun:test";
import { normalizeTokens } from "@caelo-cms/shared";
import { addModuleTool } from "../add-module.js";
import { buildPageTool } from "../build-page.js";
import { updateModulesManyTool } from "../bulk-pages-modules.js";
import { editModuleTool } from "../edit-module.js";
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
    nested?: "modules" | "updates",
  ) => {
    const props = tool.inputSchema.properties as Props;
    if (nested === undefined) return props;
    return (props[nested] as { items: { properties: Props } }).items.properties;
  };
  const cases: [string, Props][] = [
    ["add_module", entryProps(addModuleTool)],
    ["edit_module", entryProps(editModuleTool)],
    ["build_page", entryProps(buildPageTool, "modules")],
  ];
  const bulkProps = updateModulesManyTool.inputSchema.properties as Props;
  const bulkArray = Object.values(bulkProps).find(
    (p) => (p as { type?: string }).type === "array",
  ) as { items: { properties: Props } };
  cases.push(["update_modules_many", bulkArray.items.properties]);

  for (const [name, props] of cases) {
    it(`${name}: html, css and js descriptions rule out a CDATA wrapper`, () => {
      for (const key of ["html", "css", "js"]) {
        expect(String(props[key]?.description ?? "")).toContain("<![CDATA[");
      }
    });
  }
});
