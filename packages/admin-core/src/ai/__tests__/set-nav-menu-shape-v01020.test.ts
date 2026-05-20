// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.20 — `set_nav_menu` has a full per-item JSON Schema, and the
 * `## Structured-data sets you can edit` system-prompt block inlines
 * nav-menu items so the AI can copy-modify without a `structured_sets.get`
 * round-trip.
 *
 * Pre-v0.10.20:
 *  - `set_nav_menu`'s `inputSchema.items` was bare `{ type: "array" }`
 *    with no per-item shape. The AI saw "array of unknown" and guessed
 *    field shapes from the prose `description`. When the guess was
 *    wrong (object instead of array, missing `label`/`href`), Zod
 *    rejected with the unhelpful `[{ expected: "array", path: ["items"] }]`.
 *  - The structured-sets block showed counts only (`— 4 items`) with no
 *    actual items. The AI was told "Pass the FULL desired item list"
 *    but had no way to see what was currently in the menu without
 *    calling `structured_sets.get` first — and the tool description
 *    didn't mention that step.
 *
 * v0.10.20 fixes both: the JSON Schema carries the full per-item shape
 * (required `label`+`href`, optional `target`/`children`/`adSlotId`),
 * and the system-prompt formatter inlines each nav-menu's items.
 */

import { describe, expect, it } from "bun:test";

import { formatStructuredSetsBlock } from "../system-prompt.js";
import { setNavMenuTool } from "../tools/set-nav-menu.js";

describe("v0.10.20 — set_nav_menu inputSchema carries the per-item shape", () => {
  it("inputSchema.properties.items.items requires label + href", () => {
    const items = (
      setNavMenuTool.inputSchema as {
        properties: { items: { items: { required?: string[] } } };
      }
    ).properties.items.items;
    expect(items.required).toEqual(["label", "href"]);
  });

  it("items.items.properties documents target as enum + label/href as bounded strings", () => {
    const items = (
      setNavMenuTool.inputSchema as {
        properties: {
          items: {
            items: {
              additionalProperties: boolean;
              properties: {
                label: { type: string; minLength: number; maxLength: number };
                href: { type: string; minLength: number; maxLength: number };
                target: { enum: string[] };
                children: { type: string };
                adSlotId: { type: string };
              };
            };
          };
        };
      }
    ).properties.items.items;
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.label).toMatchObject({ type: "string", minLength: 1, maxLength: 120 });
    expect(items.properties.href).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(items.properties.target.enum).toEqual(["_self", "_blank"]);
    expect(items.properties.children.type).toBe("array");
    expect(items.properties.adSlotId.type).toBe("string");
  });

  it("description points the AI at the inlined items + the get-first fallback", () => {
    // The description's prose is what carries the AI's behavioural
    // guidance. Pinning the load-bearing sentences here so a future
    // edit that strips them surfaces as a test failure.
    expect(setNavMenuTool.description).toContain("inlined in the");
    expect(setNavMenuTool.description).toContain("copy them and modify");
    expect(setNavMenuTool.description).toContain("structured_sets.get");
  });
});

describe("v0.10.20 — formatStructuredSetsBlock inlines nav-menu items", () => {
  it("renders count-only for non-nav-menu kinds", () => {
    const block = formatStructuredSetsBlock([
      {
        kind: "tag",
        slug: "topics",
        displayName: "Topics",
        items: [{ slug: "ai" }, { slug: "tooling" }],
      },
    ]);
    expect(block).toContain('- tag/topics ("Topics") — 2 items');
    // The inline-item lines start with "    1. { label:" — must NOT
    // appear for non-nav-menu kinds.
    expect(block).not.toContain("    1. {");
  });

  it("inlines nav-menu items with label + href", () => {
    const block = formatStructuredSetsBlock([
      {
        kind: "nav-menu",
        slug: "header-main",
        displayName: "Header Menu",
        items: [
          { label: "Architecture", href: "/architecture" },
          { label: "Pricing", href: "/pricing" },
        ],
      },
    ]);
    expect(block).toContain('- nav-menu/header-main ("Header Menu") — 2 items:');
    expect(block).toContain('    1. { label: "Architecture", href: "/architecture" }');
    expect(block).toContain('    2. { label: "Pricing", href: "/pricing" }');
  });

  it("includes target + children count when present", () => {
    const block = formatStructuredSetsBlock([
      {
        kind: "nav-menu",
        slug: "header-main",
        displayName: "Header",
        items: [
          {
            label: "Docs",
            href: "https://docs.example.com",
            target: "_blank",
          },
          {
            label: "Products",
            href: "/products",
            children: [
              { label: "A", href: "/a" },
              { label: "B", href: "/b" },
            ],
          },
        ],
      },
    ]);
    expect(block).toContain('label: "Docs", href: "https://docs.example.com", target: "_blank"');
    expect(block).toContain('label: "Products", href: "/products", children: 2');
  });

  it("falls back to count-only when a nav-menu exceeds the 30-item cap", () => {
    const items = Array.from({ length: 31 }, (_, i) => ({
      label: `Item ${i}`,
      href: `/item-${i}`,
    }));
    const block = formatStructuredSetsBlock([
      { kind: "nav-menu", slug: "huge", displayName: "Huge", items },
    ]);
    expect(block).toContain('- nav-menu/huge ("Huge") — 31 items');
    expect(block).not.toContain("    1. {");
  });

  it("returns undefined when there are no sets", () => {
    expect(formatStructuredSetsBlock([])).toBeUndefined();
  });
});
