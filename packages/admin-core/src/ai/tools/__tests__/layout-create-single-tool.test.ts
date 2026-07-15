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

  it("the sibling layout propose-tools (update/delete/set_blocks) still exist", () => {
    // Removing the create duplicate must not touch the rest of the gated
    // layout surface — those stay in the propose-tools batch.
    expect(registry.get("propose_update_layout")).toBeDefined();
    expect(registry.get("propose_delete_layout")).toBeDefined();
    expect(registry.get("propose_set_layout_blocks")).toBeDefined();
  });
});
