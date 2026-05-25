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
 * The kind-specific wrappers are deleted. v0.10.22 originally added a
 * top-level `allOf: [{ if, then }, …]` discriminator on the
 * `set_structured_set` tool's JSON Schema so the AI's tool-call
 * validator could catch per-item shape mismatches at generation time
 * across all six kinds. The issue #47 real-AI e2e suite caught that
 * Anthropic's Messages API rejects that shape — the request lands
 * with `tools.N.custom.input_schema: input_schema does not support
 * oneOf, allOf, or anyOf at the top level`. Reverted to keeping the
 * input_schema flat and letting Zod (`validateStructuredSetItems` at
 * handler time) be the per-kind enforcer. This test now also
 * regression-guards the `allOf` removal.
 */

import { describe, expect, it } from "bun:test";
import { formatStructuredSetsBlock, formatThemeBlock } from "../system-prompt.js";
import { deleteStructuredSetTool } from "../tools/delete-structured-set.js";
import { getStructuredSetTool } from "../tools/get-structured-set.js";
import { listStructuredSetsTool } from "../tools/list-structured-sets.js";
import { setStructuredSetTool } from "../tools/set-structured-set.js";

// v0.11.0 (#45) — theme was cut out of the structured-sets primitive
// and moved to its own `themes` table with DTCG-shaped jsonb. The
// remaining structured-set kinds are the five list/tag/menu shapes.
const allKinds = ["nav-menu", "tags", "taxonomy", "link-list", "language-selector"] as const;

describe("v0.10.22 — set_structured_set unified surface + per-kind JSON Schema", () => {
  it("kind enum covers all 5 structured-set kinds (pre-v0.10.22 missed language-selector; v0.11.0 cut theme)", () => {
    const schema = setStructuredSetTool.inputSchema as {
      properties: { kind: { enum: string[] } };
    };
    expect(schema.properties.kind.enum.sort()).toEqual([...allKinds].sort());
  });

  it("input_schema does NOT use top-level allOf / oneOf / anyOf (Anthropic API rejects)", () => {
    // Regression guard for the issue #47 finding: Anthropic's Messages
    // API returns `tools.N.custom.input_schema: input_schema does not
    // support oneOf, allOf, or anyOf at the top level`. Per-kind item
    // validation lives at `structured_sets.set`'s handler via
    // `validateStructuredSetItems(kind, items)` instead.
    const schema = setStructuredSetTool.inputSchema as Record<string, unknown>;
    expect(schema.allOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
  });

  it("items is a plain array — per-kind shape enforced at handler time", () => {
    // The flat `items: { type: "array" }` shape (vs the v0.10.22-pre
    // per-kind branches) is what makes the input_schema accepted by
    // Anthropic. Per-kind item validation happens server-side; a bad
    // shape returns a structured tool error from `describeError`.
    const schema = setStructuredSetTool.inputSchema as {
      properties: { items: { type: string } };
    };
    expect(schema.properties.items.type).toBe("array");
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

  it("v0.11.0 (#45) — primer points the AI at the dedicated theme block, not structured_sets", () => {
    // Theme moved out of structured_sets into its own primitive
    // (themes table + DTCG jsonb tokens). The structured-sets primer
    // explicitly tells the AI NOT to reach for set_structured_set when
    // the operator asks about colors / fonts / theme tokens.
    const block = formatStructuredSetsBlock([]);
    expect(block).not.toContain("theme/site");
    expect(block).not.toContain("get_structured_set first, mutate in JS");
    expect(block).toContain("set_theme_tokens");
    expect(block).toContain("propose_create_theme");
  });

  it("v0.11.0 (#45) — formatThemeBlock renders the dedicated `## Theme` section", () => {
    const block = formatThemeBlock({
      slug: "site-default",
      displayName: "Site default",
      tokensSummary: "8 colors, 5 typography, 6 spacing",
    });
    expect(block).toContain("## Theme");
    expect(block).toContain("site-default");
    expect(block).toContain("Site default");
    expect(block).toContain("8 colors, 5 typography, 6 spacing");
    // The block lists every routine + propose theme tool the AI can
    // call so it doesn't need a separate catalogue lookup.
    expect(block).toContain("set_theme_tokens");
    expect(block).toContain("propose_create_theme");
    expect(block).toContain("propose_activate_theme");
    expect(block).toContain("propose_delete_theme");
  });

  it("v0.11.0 (#45) — formatThemeBlock null branch tells the AI to propose one", () => {
    const block = formatThemeBlock(null);
    expect(block).toContain("## Theme");
    expect(block).toContain("No active theme");
    expect(block).toContain("propose_create_theme");
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
