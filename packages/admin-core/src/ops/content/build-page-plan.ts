// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — pure placement planner for `pages.build_page`.
 *
 * Given the page's current layout (branch-overlay-aware, loaded by the
 * op) and the resolved new placements (moduleId + contentInstanceId +
 * syncMode per build entry), computes the merged next layout: existing
 * placements are preserved verbatim, new ones are inserted into their
 * target block in input order — appended unless the entry names a
 * `position`. Also decides the order entries are minted in, so a
 * `{"$ref"}` may name an entry later in the array ({@link
 * orderBuildEntries}). Pure functions so the arithmetic is unit-testable
 * without a database.
 */

import type { PageLayoutState } from "../../snapshots/state.js";

export interface ResolvedBuildPlacement {
  readonly blockName: string;
  readonly moduleId: string;
  readonly contentInstanceId: string;
  readonly syncMode: "synced" | "unsynced";
  /** "top", "bottom" or a 0-based index into the block; absent = "bottom". */
  readonly position?: "top" | "bottom" | number;
}

export interface PlannedPlacement extends Omit<ResolvedBuildPlacement, "position"> {
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
 * first-appearance order. Within a block, each addition is inserted, in
 * the order they appear in `additions`, at its `position` in the block
 * as it stands at that moment: "bottom" (the default) appends, "top" is
 * index 0, an index past the end appends. The returned positions are the
 * FINAL ones, after every insertion.
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
    /** One identity per moduleIds slot, so a slot's final index can be
     *  read back after later insertions shifted it. */
    slots: object[];
  };
  const blocks: MutableBlock[] = base.blocks.map((b) => ({
    blockName: b.blockName,
    moduleIds: [...b.moduleIds],
    placements: (b.placements ?? []).map((p) => ({ ...p })),
    slots: b.moduleIds.map(() => ({})),
  }));
  const byName = new Map(blocks.map((b) => [b.blockName, b]));

  const inserted: { block: MutableBlock; slot: object }[] = [];
  for (const add of additions) {
    let block = byName.get(add.blockName);
    if (!block) {
      block = { blockName: add.blockName, moduleIds: [], placements: [], slots: [] };
      blocks.push(block);
      byName.set(add.blockName, block);
    }
    // Indices are into moduleIds, NOT placements — a pre-v0.12 base
    // block may carry moduleIds without placements and a bottom insert
    // must still land after the real occupants.
    const end = block.moduleIds.length;
    const at =
      add.position === undefined || add.position === "bottom"
        ? end
        : add.position === "top"
          ? 0
          : Math.min(add.position, end);
    const gap = end - block.placements.length;
    const slot = {};
    block.moduleIds.splice(at, 0, add.moduleId);
    block.slots.splice(at, 0, slot);
    block.placements.splice(Math.max(0, at - gap), 0, {
      moduleId: add.moduleId,
      contentInstanceId: add.contentInstanceId,
      syncMode: add.syncMode,
    });
    inserted.push({ block, slot });
  }

  const appended: PlannedPlacement[] = additions.map((add, i) => {
    const { block, slot } = inserted[i] as (typeof inserted)[number];
    const { position: _requested, ...placement } = add;
    return { ...placement, position: block.slots.indexOf(slot) };
  });

  return {
    nextLayout: {
      schemaVersion: 1,
      blocks: blocks.map(({ slots: _slots, ...b }) => b),
    },
    appended,
  };
}

/** One build_page entry as {@link orderBuildEntries} reads it. */
export interface BuildEntryRefs {
  readonly ref?: string;
  readonly moduleId?: string | { readonly $ref: string };
  readonly content?: { readonly source: string; readonly values?: unknown };
}

/** Every `{"$ref": "<handle>"}` marker inside a content value. */
function collectRefHandles(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectRefHandles(v, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$ref") {
    const handle = (value as { $ref: unknown }).$ref;
    out.push(typeof handle === "string" ? handle : JSON.stringify(handle));
    return;
  }
  for (const v of Object.values(value)) collectRefHandles(v, out);
}

/**
 * The order build_page mints its entries in: every entry after the
 * entries its `{"$ref"}` markers name, otherwise array order. A handle
 * is a name, not a position — requiring the referenced entry to come
 * first was an ordering rule the AI kept tripping over (the feature grid
 * written before its card module) with no meaning of its own: placement
 * order on the page is still the array order.
 *
 * @returns the entry indices in minting order, or the AI-actionable
 *   message for every handle no entry declares and every self-reference
 *   (`issues`, per entry index), or for a cycle (`index: -1`).
 */
export function orderBuildEntries(
  entries: readonly BuildEntryRefs[],
):
  | { ok: true; order: number[] }
  | { ok: false; message: string; issues: { index: number; message: string }[] } {
  const byHandle = new Map<string, number>();
  for (const [i, e] of entries.entries()) if (e.ref !== undefined) byHandle.set(e.ref, i);
  const declared = [...byHandle.keys()].join(", ") || "(none)";

  const deps: Set<number>[] = [];
  // #1277 — every unknown or self handle is reported, not only the first.
  const issues: { index: number; message: string }[] = [];
  for (const [i, e] of entries.entries()) {
    const handles: string[] = [];
    if (e.moduleId !== undefined && typeof e.moduleId !== "string") handles.push(e.moduleId.$ref);
    if (e.content !== undefined && e.content.source !== "existing") {
      collectRefHandles(e.content.values, handles);
    }
    const need = new Set<number>();
    for (const h of handles) {
      const target = byHandle.get(h);
      if (target === undefined) {
        issues.push({
          index: i,
          message:
            `{"$ref": ${JSON.stringify(h)}} does not match any entry's \`ref\` in this call. ` +
            `Refs declared: ${declared} — give the module you mean \`ref: ${JSON.stringify(h)}\` (its position in the array does not matter), ` +
            "or pass an existing module's UUID as moduleId",
        });
        continue;
      }
      if (target === i) {
        issues.push({
          index: i,
          message: `{"$ref": ${JSON.stringify(h)}} names the entry itself — a module cannot embed itself`,
        });
        continue;
      }
      need.add(target);
    }
    deps.push(need);
  }
  if (issues.length > 0) {
    return {
      ok: false,
      message: issues.map((x) => `modules[${x.index}]: ${x.message}.`).join(" "),
      issues,
    };
  }

  // Kahn's algorithm, always taking the lowest ready index so a call
  // without references keeps exact array order.
  const order: number[] = [];
  const done = new Set<number>();
  while (order.length < entries.length) {
    let next = -1;
    for (let i = 0; i < entries.length; i += 1) {
      if (done.has(i)) continue;
      if ([...(deps[i] as Set<number>)].every((d) => done.has(d))) {
        next = i;
        break;
      }
    }
    if (next === -1) {
      const stuck = entries
        .map((e, i) => (done.has(i) ? null : `modules[${i}]${e.ref ? ` (ref '${e.ref}')` : ""}`))
        .filter((x): x is string => x !== null);
      const message =
        `{"$ref"} cycle between ${stuck.join(", ")}: each embeds another, so none can be created first. ` +
        "Nesting must form a tree — remove the reference that points back.";
      return { ok: false, message, issues: [{ index: -1, message }] };
    }
    order.push(next);
    done.add(next);
  }
  return { ok: true, order };
}
