// SPDX-License-Identifier: MPL-2.0

/**
 * Catalogue-consolidation guard: layout-create is offered to the AI as
 * exactly ONE tool — `create_layout` — not two. There used to be a second,
 * inferior duplicate (`propose_create_layout` from the propose-tools batch)
 * that wrapped the SAME `layouts.propose_create` op but lacked the required
 * `blocks[]` (block-set metadata). Two tools for one gated action, with
 * divergent schemas, is catalogue confusion + wasted schema tokens. This test
 * fails if the duplicate ever comes back, or if `create_layout` loses `blocks`.
 */

import { describe, expect, it } from "bun:test";
import { createDefaultToolRegistry } from "../index.js";

const registry = createDefaultToolRegistry();

describe("layout-create is a single canonical tool", () => {
  it("offers create_layout and NOT the propose_create_layout duplicate", () => {
    expect(registry.get("create_layout")).toBeDefined();
    expect(registry.get("propose_create_layout")).toBeUndefined();
  });

  it("create_layout carries the required block-set metadata (blocks[])", () => {
    const tool = registry.get("create_layout");
    const schema = (tool as { inputSchema?: { required?: string[] } } | undefined)?.inputSchema;
    expect(schema?.required).toContain("blocks");
  });

  it("the sibling layout propose-tools (update/delete) still exist", () => {
    // Removing the create duplicate must not touch the rest of the gated
    // layout surface.
    expect(registry.get("propose_update_layout")).toBeDefined();
    expect(registry.get("propose_delete_layout")).toBeDefined();
  });

  it("1b: layout-update carries blocks inline; the separate set-blocks tool is gone", () => {
    // Redefining a layout's block-set is folded into propose_update_layout
    // (symmetric with propose_update_template), so the standalone
    // propose_set_layout_blocks AI tool is removed. One tool, one atomic
    // proposal for html + blocks.
    const update = registry.get("propose_update_layout");
    const schema = (update as { inputSchema?: { properties?: Record<string, unknown> } } | undefined)
      ?.inputSchema;
    expect(schema?.properties?.blocks).toBeDefined();
    expect(registry.get("propose_set_layout_blocks")).toBeUndefined();
  });
});
