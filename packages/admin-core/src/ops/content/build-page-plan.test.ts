// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — unit tests for the pure placement planner behind
 * `pages.build_page`: append arithmetic, block-order preservation,
 * new-block creation, and the pre-v0.12 moduleIds-without-placements
 * position rule.
 */

import { describe, expect, it } from "bun:test";
import type { PageLayoutState } from "../../snapshots/state.js";
import { planBuildPagePlacements } from "./build-page-plan.js";

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
