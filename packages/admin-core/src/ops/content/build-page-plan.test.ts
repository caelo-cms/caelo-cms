// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — unit tests for the pure placement planner behind
 * `pages.build_page`: append arithmetic, block-order preservation,
 * new-block creation, and the pre-v0.12 moduleIds-without-placements
 * position rule.
 */

import { describe, expect, it } from "bun:test";
import type { PageLayoutState } from "../../snapshots/state.js";
import { orderBuildEntries, planBuildPagePlacements } from "./build-page-plan.js";

const M = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const C = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;

const emptyBase: PageLayoutState = { schemaVersion: 1, blocks: [] };

describe("planBuildPagePlacements", () => {
  it("places additions at 0..n-1 in input order on an empty page", () => {
    const plan = planBuildPagePlacements(emptyBase, [
      { blockName: "content", moduleId: M(1), contentInstanceId: C(1), syncMode: "unsynced" },
      { blockName: "content", moduleId: M(2), contentInstanceId: C(2), syncMode: "synced" },
      { blockName: "content", moduleId: M(3), contentInstanceId: C(3), syncMode: "unsynced" },
    ]);
    expect(plan.appended.map((p) => p.position)).toEqual([0, 1, 2]);
    expect(plan.nextLayout.blocks).toHaveLength(1);
    expect(plan.nextLayout.blocks[0]!.moduleIds).toEqual([M(1), M(2), M(3)]);
    expect(plan.nextLayout.blocks[0]!.placements).toHaveLength(3);
    expect(plan.nextLayout.blocks[0]!.placements![1]!.syncMode).toBe("synced");
  });

  it("appends AFTER existing placements and preserves their bindings verbatim", () => {
    const base: PageLayoutState = {
      schemaVersion: 1,
      blocks: [
        {
          blockName: "content",
          moduleIds: [M(9)],
          placements: [{ moduleId: M(9), contentInstanceId: C(9), syncMode: "synced" }],
        },
      ],
    };
    const plan = planBuildPagePlacements(base, [
      { blockName: "content", moduleId: M(1), contentInstanceId: C(1), syncMode: "unsynced" },
    ]);
    expect(plan.appended[0]!.position).toBe(1);
    const block = plan.nextLayout.blocks[0]!;
    expect(block.moduleIds).toEqual([M(9), M(1)]);
    expect(block.placements![0]).toEqual({
      moduleId: M(9),
      contentInstanceId: C(9),
      syncMode: "synced",
    });
  });

  it("interleaves multiple blocks — per-block positions, base block order kept, new blocks appended", () => {
    const base: PageLayoutState = {
      schemaVersion: 1,
      blocks: [
        {
          blockName: "sidebar",
          moduleIds: [M(8)],
          placements: [{ moduleId: M(8), contentInstanceId: C(8), syncMode: "unsynced" }],
        },
      ],
    };
    const plan = planBuildPagePlacements(base, [
      { blockName: "content", moduleId: M(1), contentInstanceId: C(1), syncMode: "unsynced" },
      { blockName: "sidebar", moduleId: M(2), contentInstanceId: C(2), syncMode: "unsynced" },
      { blockName: "content", moduleId: M(3), contentInstanceId: C(3), syncMode: "unsynced" },
    ]);
    expect(plan.appended.map((p) => [p.blockName, p.position])).toEqual([
      ["content", 0],
      ["sidebar", 1],
      ["content", 1],
    ]);
    expect(plan.nextLayout.blocks.map((b) => b.blockName)).toEqual(["sidebar", "content"]);
  });

  it("pre-v0.12 base blocks (moduleIds without placements) still yield correct positions", () => {
    const base: PageLayoutState = {
      schemaVersion: 1,
      blocks: [{ blockName: "content", moduleIds: [M(7), M(8)] }],
    };
    const plan = planBuildPagePlacements(base, [
      { blockName: "content", moduleId: M(1), contentInstanceId: C(1), syncMode: "unsynced" },
    ]);
    // Position derives from moduleIds length (2), NOT the empty
    // placements array — the new module lands after the real occupants.
    expect(plan.appended[0]!.position).toBe(2);
    expect(plan.nextLayout.blocks[0]!.moduleIds).toEqual([M(7), M(8), M(1)]);
  });

  it("does not mutate the base layout", () => {
    const base: PageLayoutState = {
      schemaVersion: 1,
      blocks: [
        {
          blockName: "content",
          moduleIds: [M(9)],
          placements: [{ moduleId: M(9), contentInstanceId: C(9), syncMode: "synced" }],
        },
      ],
    };
    planBuildPagePlacements(base, [
      { blockName: "content", moduleId: M(1), contentInstanceId: C(1), syncMode: "unsynced" },
    ]);
    expect(base.blocks[0]!.moduleIds).toEqual([M(9)]);
    expect(base.blocks[0]!.placements).toHaveLength(1);
  });
});

// e2e-livedit detected bugs: build_page refused `position` (carried over
// from add_module) and a {"$ref"} to an entry later in the array.
describe("planBuildPagePlacements — entry `position`", () => {
  const base: PageLayoutState = {
    schemaVersion: 1,
    blocks: [
      {
        blockName: "content",
        moduleIds: [M(8), M(9)],
        placements: [
          { moduleId: M(8), contentInstanceId: C(8), syncMode: "unsynced" },
          { moduleId: M(9), contentInstanceId: C(9), syncMode: "unsynced" },
        ],
      },
    ],
  };
  const add = (n: number, position?: "top" | "bottom" | number) => ({
    blockName: "content",
    moduleId: M(n),
    contentInstanceId: C(n),
    syncMode: "unsynced" as const,
    ...(position !== undefined ? { position } : {}),
  });

  it("inserts at the top, at an index, and appends past the end", () => {
    const plan = planBuildPagePlacements(base, [add(1, "top"), add(2, 2), add(3, 99)]);
    const block = plan.nextLayout.blocks[0]!;
    expect(block.moduleIds).toEqual([M(1), M(8), M(2), M(9), M(3)]);
    expect(block.placements!.map((p) => p.contentInstanceId)).toEqual([
      C(1),
      C(8),
      C(2),
      C(9),
      C(3),
    ]);
    // Final positions, after every insertion.
    expect(plan.appended.map((p) => p.position)).toEqual([0, 2, 4]);
  });

  it("reports final positions when a later entry is inserted above an earlier one", () => {
    const plan = planBuildPagePlacements(base, [add(1, "bottom"), add(2, "top")]);
    expect(plan.nextLayout.blocks[0]!.moduleIds).toEqual([M(2), M(8), M(9), M(1)]);
    expect(plan.appended.map((p) => [p.moduleId, p.position])).toEqual([
      [M(1), 3],
      [M(2), 0],
    ]);
  });
});

describe("orderBuildEntries", () => {
  const card = { ref: "card", content: { source: "inline", values: { title: "A" } } };
  const grid = {
    content: { source: "inline", values: { cards: [{ $ref: "card" }, { $ref: "card2" }] } },
  };
  const card2 = { ref: "card2", content: { source: "inline", values: {} } };

  it("keeps array order when nothing references a later entry", () => {
    expect(orderBuildEntries([card, card2, grid])).toEqual({ ok: true, order: [0, 1, 2] });
  });

  it("mints referenced entries first, whatever their array position", () => {
    // The live-run shape: hero, then the grid embedding cards declared after it.
    const hero = { content: { source: "inline", values: { headline: "Hi" } } };
    expect(orderBuildEntries([hero, grid, card, card2])).toEqual({
      ok: true,
      order: [0, 2, 3, 1],
    });
    // moduleId {"$ref"} re-placement counts as a dependency too.
    expect(orderBuildEntries([{ moduleId: { $ref: "card" } }, card])).toEqual({
      ok: true,
      order: [1, 0],
    });
  });

  it("names an unknown handle and the declared ones", () => {
    const r = orderBuildEntries([
      card,
      { content: { source: "inline", values: { x: { $ref: "nope" } } } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('modules[1]: {"$ref": "nope"}');
      expect(r.message).toContain("Refs declared: card");
    }
  });

  it("refuses self-references and cycles", () => {
    const self = orderBuildEntries([
      { ref: "a", content: { source: "inline", values: { m: { $ref: "a" } } } },
    ]);
    expect(self.ok).toBe(false);
    const cycle = orderBuildEntries([
      { ref: "a", content: { source: "inline", values: { m: { $ref: "b" } } } },
      { ref: "b", content: { source: "inline", values: { m: { $ref: "a" } } } },
    ]);
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.message).toContain("cycle");
  });

  it("ignores $ref-shaped data of an `existing` content binding", () => {
    expect(
      orderBuildEntries([{ content: { source: "existing", values: { m: { $ref: "zzz" } } } }]),
    ).toEqual({ ok: true, order: [0] });
  });
});
