// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.22 — consolidated structured-sets CRUD surface.
 *
 * Pre-v0.10.22:
 *  - The AI saw `set_structured_set` (generic) PLUS kind-specific
 *    wrappers `set_nav_menu` and `update_theme`. Three tools touching
 *    the same primitive, with inconsistent ergonomics + a 6th kind
 *    (`language-selector`) unreachable from any tool.
 *  - No list/get/delete AI tools — the AI relied on the system-prompt
 *    block (frozen at turn start) and couldn't refresh mid-conversation
 *    or remove a set.
 *
 * v0.10.22 ships one unified CRUD surface:
 *  - `list_structured_sets({ kind? })`
 *  - `get_structured_set({ kind, slug })`
 *  - `set_structured_set({ kind, slug, displayName, items })`
 *  - `delete_structured_set({ kind, slug })`
 *
 * The kind-specific wrappers are deleted. `set_structured_set`'s
 * JSON Schema branches per `kind` so the AI's tool-call validator
 * catches per-item shape mismatches at generation time across ALL
 * six kinds (not just nav-menu, as v0.10.20 narrowly covered).
 */

import { describe, expect, it } from "bun:test";
import { formatStructuredSetsBlock } from "../system-prompt.js";
import { deleteStructuredSetTool } from "../tools/delete-structured-set.js";
import { getStructuredSetTool } from "../tools/get-structured-set.js";
import { listStructuredSetsTool } from "../tools/list-structured-sets.js";
import { setStructuredSetTool } from "../tools/set-structured-set.js";

const allKinds = [
  "nav-menu",
  "tags",
  "taxonomy",
  "theme",
  "link-list",
  "language-selector",
] as const;

describe("v0.10.22 — set_structured_set unified surface + per-kind JSON Schema", () => {
  it("kind enum covers all 6 structured-set kinds (pre-v0.10.22 missed language-selector)", () => {
    const schema = setStructuredSetTool.inputSchema as {
      properties: { kind: { enum: string[] } };
    };
    expect(schema.properties.kind.enum.sort()).toEqual([...allKinds].sort());
  });

  it("has an allOf branch for each kind discriminating items", () => {
    const schema = setStructuredSetTool.inputSchema as {
      allOf: Array<{ if: { properties: { kind: { const: string } } } }>;
    };
    const branchedKinds = schema.allOf.map((b) => b.if.properties.kind.const).sort();
    expect(branchedKinds).toEqual([...allKinds].sort());
  });

  it("nav-menu branch requires label + href on each item", () => {
    const schema = setStructuredSetTool.inputSchema as {
      allOf: Array<{
        if: { properties: { kind: { const: string } } };
        then: { properties: { items: { items: { required: string[] } } } };
      }>;
    };
    const navBranch = schema.allOf.find((b) => b.if.properties.kind.const === "nav-menu");
    expect(navBranch?.then.properties.items.items.required).toEqual(["label", "href"]);
  });

  it("tags branch requires slug + displayName (NOT label/href — the v0.10.20 nav-menu shape)", () => {
    const schema = setStructuredSetTool.inputSchema as {
      allOf: Array<{
        if: { properties: { kind: { const: string } } };
        then: { properties: { items: { items: { required: string[] } } } };
      }>;
    };
    const tagBranch = schema.allOf.find((b) => b.if.properties.kind.const === "tags");
    expect(tagBranch?.then.properties.items.items.required).toEqual(["slug", "displayName"]);
  });

  it("theme branch requires token + value + pins the lowercase-kebab-case pattern", () => {
    const schema = setStructuredSetTool.inputSchema as {
      allOf: Array<{
        if: { properties: { kind: { const: string } } };
        then: {
          properties: {
            items: {
              items: {
                required: string[];
                properties: { token: { pattern: string } };
              };
            };
          };
        };
      }>;
    };
    const themeBranch = schema.allOf.find((b) => b.if.properties.kind.const === "theme");
    expect(themeBranch?.then.properties.items.items.required).toEqual(["token", "value"]);
    expect(themeBranch?.then.properties.items.items.properties.token.pattern).toBe(
      "^[a-z][a-z0-9-]*$",
    );
  });

  it("language-selector branch requires locale (the previously-unreachable kind)", () => {
    const schema = setStructuredSetTool.inputSchema as {
      allOf: Array<{
        if: { properties: { kind: { const: string } } };
        then: { properties: { items: { items: { required: string[] } } } };
      }>;
    };
    const langBranch = schema.allOf.find((b) => b.if.properties.kind.const === "language-selector");
    expect(langBranch?.then.properties.items.items.required).toEqual(["locale"]);
  });

  it("description references the unified surface, not the removed wrappers", () => {
    expect(setStructuredSetTool.description).toContain("Upsert");
    expect(setStructuredSetTool.description).not.toContain("set_nav_menu");
    expect(setStructuredSetTool.description).not.toContain("update_theme");
    expect(setStructuredSetTool.description).toContain("get_structured_set");
  });
});

describe("v0.10.22 — new CRUD tools", () => {
  it("list_structured_sets accepts optional kind filter", () => {
    expect(listStructuredSetsTool.name).toBe("list_structured_sets");
    const schema = listStructuredSetsTool.inputSchema as {
      required?: string[];
      properties: { kind: { enum: string[] } };
    };
    expect(schema.required).toBeUndefined();
    expect(schema.properties.kind.enum.sort()).toEqual([...allKinds].sort());
  });

  it("get_structured_set requires kind + slug", () => {
    expect(getStructuredSetTool.name).toBe("get_structured_set");
    const schema = getStructuredSetTool.inputSchema as {
      required: string[];
      properties: { kind: { enum: string[] } };
    };
    expect(schema.required).toEqual(["kind", "slug"]);
    expect(schema.properties.kind.enum.sort()).toEqual([...allKinds].sort());
  });

  it("delete_structured_set requires kind + slug (NOT setId — the underlying op's shape)", () => {
    // The op takes `setId` but the AI tool wraps it to take kind+slug
    // so the AI never has to know raw set IDs.
    expect(deleteStructuredSetTool.name).toBe("delete_structured_set");
    const schema = deleteStructuredSetTool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["kind", "slug"]);
    expect(schema.properties.setId).toBeUndefined();
  });
});

describe("v0.10.22 — system-prompt primer references the unified tools", () => {
  it("primer references the four CRUD tools, not the removed wrappers", () => {
    const block = formatStructuredSetsBlock([]);
    expect(block).toContain("list_structured_sets");
    expect(block).toContain("get_structured_set");
    expect(block).toContain("set_structured_set");
    expect(block).toContain("delete_structured_set");
    expect(block).not.toContain("set_nav_menu");
    expect(block).not.toContain("update_theme");
  });

  it("primer still explains the renderer convention + the navigation→nav-menu mapping", () => {
    const block = formatStructuredSetsBlock([]);
    expect(block).toContain("nav-menu-X");
    expect(block).toContain('"navigation"');
  });

  it("primer covers theme partial-update workflow (get → mutate → set)", () => {
    const block = formatStructuredSetsBlock([]);
    expect(block).toContain("get_structured_set");
    expect(block).toContain("partial updates");
  });

  it("nav-menu item inlining still works when sets exist (v0.10.20 behavior preserved)", () => {
    const block = formatStructuredSetsBlock([
      {
        kind: "nav-menu",
        slug: "header-main",
        displayName: "Header menu",
        items: [{ label: "Home", href: "/" }],
      },
    ]);
    expect(block).toContain('- nav-menu/header-main ("Header menu") — 1 item:');
    expect(block).toContain('1. { label: "Home", href: "/" }');
  });
});
