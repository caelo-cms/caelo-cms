// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — guard tests for the bulk build-path tools.
 *
 * Pins three contracts:
 *  1. Registration — build_page / create_content_instances /
 *     set_page_module_content_many are in the default tool registry.
 *  2. Single-source schemas — build_page's nested module items reference
 *     the SAME MODULE_FIELDS_JSON_SCHEMA / MODULE_META_JSON_SCHEMA_PROPS
 *     objects the singular authoring tools use (identity, not deep-equal
 *     copies — a copy is exactly the drift issue #106 fought).
 *  3. §11 bulk-first steering — the bulk tools tell the AI when to
 *     prefer them and the singular tools point at the bulk variants for
 *     multi-element work, so the run-#15 singular-chain pattern can't
 *     silently return.
 */

import { describe, expect, it } from "bun:test";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "../_module-fields-schema.js";
import { addModuleTool } from "../add-module.js";
import { buildPageTool } from "../build-page.js";
import { createContentInstanceTool } from "../create-content-instance.js";
import { createContentInstancesTool } from "../create-content-instances.js";
import { createPageTool } from "../create-page.js";
import { createDefaultToolRegistry } from "../index.js";
import { setPageModuleContentTool } from "../set-page-module-content.js";
import { setPageModuleContentManyTool } from "../set-page-module-content-many.js";

function moduleItemProps(): Record<string, unknown> {
  const props = buildPageTool.inputSchema.properties as Record<string, unknown>;
  const modules = props.modules as Record<string, unknown>;
  const items = modules.items as Record<string, unknown>;
  return items.properties as Record<string, unknown>;
}

describe("bulk build tools are registered (#299)", () => {
  const registry = createDefaultToolRegistry();
  const names = registry.catalogue().map((t) => t.name);
  for (const name of ["build_page", "create_content_instances", "set_page_module_content_many"]) {
    it(`${name} is in the default registry`, () => {
      expect(names).toContain(name);
    });
  }
});

describe("build_page schema stays on the shared single sources (#106 discipline)", () => {
  it("nested fields schema IS the shared MODULE_FIELDS_JSON_SCHEMA object", () => {
    // Identity check: a deep-equal copy would still drift later.
    expect(moduleItemProps().fields).toBe(MODULE_FIELDS_JSON_SCHEMA);
  });

  it("nested meta props mirror MODULE_META_JSON_SCHEMA_PROPS (description/kind/type)", () => {
    const props = moduleItemProps();
    for (const key of Object.keys(MODULE_META_JSON_SCHEMA_PROPS)) {
      expect(props[key]).toEqual(
        (MODULE_META_JSON_SCHEMA_PROPS as Record<string, unknown>)[key] as never,
      );
    }
  });

  it("meta block matches add_module's exactly (no drift across authoring tools)", () => {
    const addProps = addModuleTool.inputSchema.properties as Record<string, unknown>;
    const buildProps = moduleItemProps();
    for (const key of ["description", "kind", "type"]) {
      expect(buildProps[key]).toEqual(addProps[key] as never);
    }
  });
});

describe("§11 bulk-first steering wording", () => {
  it("build_page tells the AI to prefer it over the singular chain", () => {
    expect(buildPageTool.description).toContain("Prefer this over add_module");
    expect(buildPageTool.description).toContain("ONE transaction");
  });

  it("add_module points multi-module work at build_page", () => {
    expect(addModuleTool.description).toContain("build_page");
    expect(addModuleTool.description).toContain("more than one module");
  });

  it("create_page points known-content builds at build_page", () => {
    expect(createPageTool.description).toContain("build_page");
  });

  it("create_content_instance points multi-instance work at the plural tool", () => {
    expect(createContentInstanceTool.description).toContain("create_content_instances");
    expect(createContentInstanceTool.description).toContain("build_page");
  });

  it("create_content_instances steers back to build_page for full assembly", () => {
    expect(createContentInstancesTool.description).toContain("build_page");
    expect(createContentInstancesTool.description).toContain("All-or-nothing");
  });

  it("set_page_module_content points multi-placement passes at the _many variant", () => {
    expect(setPageModuleContentTool.description).toContain("set_page_module_content_many");
  });

  it("set_page_module_content_many carries the abort + synced-placement contract", () => {
    expect(setPageModuleContentManyTool.description).toContain("All-or-nothing");
    expect(setPageModuleContentManyTool.description).toContain("fork_placement_content");
    expect(setPageModuleContentManyTool.description).toContain("build_page");
  });
});

describe("build_page describeSchema pins the nested blockName enum", () => {
  it("pins modules[].blockName to the focused page's blocks", () => {
    const state = {
      activePage: { blockNames: ["header", "content", "footer"] },
      templates: [{ slug: "t" }],
    } as never;
    const schema = buildPageTool.describeSchema!(state);
    const props = schema.properties as Record<string, unknown>;
    const modules = props.modules as Record<string, unknown>;
    const items = modules.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, unknown>;
    const blockName = itemProps.blockName as { enum?: string[] };
    expect(blockName.enum).toEqual(["header", "content", "footer"]);
  });

  it("falls back to the static schema when no page is focused", () => {
    const schema = buildPageTool.describeSchema!({ activePage: undefined, templates: [] } as never);
    expect(schema).toBe(buildPageTool.inputSchema);
  });
});
