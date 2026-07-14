// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — pure placement planner for `pages.build_page`.
 *
 * Given the page's current layout (branch-overlay-aware, loaded by the
 * op) and the resolved new placements (moduleId + contentInstanceId +
 * syncMode per build entry), computes the merged next layout: existing
 * placements are preserved verbatim, new ones are APPENDED to their
 * target block in input order. Pure function so the append/merge
 * arithmetic is unit-testable without a database.
 */

import type { PageLayoutState } from "../../snapshots/state.js";

export interface ResolvedBuildPlacement {
  readonly blockName: string;
  readonly moduleId: string;
  readonly contentInstanceId: string;
  readonly syncMode: "synced" | "unsynced";
}

export interface PlannedPlacement extends ResolvedBuildPlacement {
  /** Final 0-based position inside the block after the merge. */
  readonly position: number;
}

export interface BuildPagePlan {
  /** The merged layout — feed to the branched snapshot / live INSERTs. */
  readonly nextLayout: PageLayoutState;
  /** New placements only, with their final positions, in input order. */
  readonly appended: readonly PlannedPlacement[];
}

/**
 * Merge `additions` into `base`. Blocks keep their existing order;
 * blocks that only exist in `additions` are appended after them in
 * first-appearance order. Within a block, additions land after the
 * existing placements, in the order they appear in `additions`.
 *
 * Base blocks whose `placements` are missing (pre-v0.12 snapshots)
 * are carried through with their `moduleIds` only — the op validates
 * that case upstream, since live re-INSERT needs a binding per row.
 */
export function planBuildPagePlacements(
  base: PageLayoutState,
  additions: readonly ResolvedBuildPlacement[],
): BuildPagePlan {
  type MutableBlock = {
    blockName: string;
    moduleIds: string[];
    placements: {
      moduleId: string;
      contentInstanceId: string;
      syncMode: "synced" | "unsynced";
    }[];
  };
  const blocks: MutableBlock[] = base.blocks.map((b) => ({
    blockName: b.blockName,
    moduleIds: [...b.moduleIds],
    placements: (b.placements ?? []).map((p) => ({ ...p })),
  }));
  const byName = new Map(blocks.map((b) => [b.blockName, b]));

  const appended: PlannedPlacement[] = [];
  for (const add of additions) {
    let block = byName.get(add.blockName);
    if (!block) {
      block = { blockName: add.blockName, moduleIds: [], placements: [] };
      blocks.push(block);
      byName.set(add.blockName, block);
    }
    // Position derives from moduleIds length, NOT placements length —
    // a pre-v0.12 base block may carry moduleIds without placements
    // and the new module must still land after the real occupants.
    const position = block.moduleIds.length;
    block.moduleIds.push(add.moduleId);
    block.placements.push({
      moduleId: add.moduleId,
      contentInstanceId: add.contentInstanceId,
      syncMode: add.syncMode,
    });
    appended.push({ ...add, position });
  }

  return {
    nextLayout: { schemaVersion: 1, blocks },
    appended,
  };
}
