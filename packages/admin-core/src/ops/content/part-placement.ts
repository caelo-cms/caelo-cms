// SPDX-License-Identifier: MPL-2.0

/**
 * Where changed parts render, for the operator-facing change lists: the
 * Draft changes summary (`chat.list_open_changes`) and the Publish live
 * review (`deploy.publish_preview`) count a part shown on one page as a
 * change of that page and list only the rest as site-wide (part-where.ts).
 *
 *   - A content instance renders where {@link loadContentInstanceReach}
 *     says: its placements, every parent that shows it, module defaults
 *     (layout chrome) and shared lists. The delete guard and the
 *     incremental Stage read the same reach.
 *   - A module renders where its instances render (every page placement
 *     and every nested use holds one), and on every page of a layout whose
 *     chrome places it. Its instances are read up to
 *     {@link PART_INSTANCE_CAP}; a module with more counts as shown on many
 *     pages without reading them all.
 *
 * Every read is bounded per part (instances per module, placements per
 * instance: {@link PART_PAGE_CAP}), so the cost follows the changed parts,
 * never how widely a section design or a synced content is used. All parts
 * are read in one batch, about twenty statements whatever their number.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { layoutsPlacingModules, loadContentInstanceReach } from "./content-instance-reach.js";
import { findContentInstancesOfModules } from "./content-instance-refs.js";
import type { PartPage, PartPlacement } from "./part-where.js";

/** Instances of one module read at most; a module with more shows on many pages. */
export const PART_INSTANCE_CAP = 100;

/**
 * Placements read at most per content instance (and per module whose
 * default shows it); one with more shows on many pages. A CTA synced on
 * every page of a 50,000-page site costs this many rows, not 50,000.
 */
export const PART_PAGE_CAP = 100;

/** A changed part whose placement decides how it is listed. */
export interface PartRef {
  readonly kind: "module" | "contentInstance";
  readonly id: string;
}

/** The key of a part in {@link loadPartPlacements}' map: `module:<id>` or `contentInstance:<id>`. */
export function partKey(part: PartRef): string {
  return `${part.kind}:${part.id}`;
}

/** The placement of `part` in a {@link loadPartPlacements} result; throws when it was not read. */
export function placementOf(
  placements: ReadonlyMap<string, PartPlacement>,
  part: PartRef,
): PartPlacement {
  const placement = placements.get(partKey(part));
  if (!placement) throw new Error(`loadPartPlacements: ${partKey(part)} was not read`);
  return placement;
}

/**
 * Where each of `parts` renders as `branchId` sees the site (null: main,
 * which is what the last Stage merged). Every part is in the result.
 */
export async function loadPartPlacements(
  tx: TransactionRunner,
  branchId: string | null,
  parts: readonly PartRef[],
): Promise<Map<string, PartPlacement>> {
  const out = new Map<string, PartPlacement>();
  if (parts.length === 0) return out;
  const instanceIds = [
    ...new Set(parts.filter((p) => p.kind === "contentInstance").map((p) => p.id)),
  ];
  const moduleIds = [...new Set(parts.filter((p) => p.kind === "module").map((p) => p.id))];

  const instancesOf = new Map<string, string[]>();
  for (const id of moduleIds) instancesOf.set(id, []);
  for (const ci of await findContentInstancesOfModules(
    tx,
    branchId,
    moduleIds,
    PART_INSTANCE_CAP + 1,
  )) {
    instancesOf.get(ci.moduleId)?.push(ci.contentInstanceId);
  }
  const reach = await loadContentInstanceReach(
    tx,
    branchId,
    [...instanceIds, ...[...instancesOf.values()].flat()],
    { placementsPerSource: PART_PAGE_CAP },
  );
  const chrome = moduleIds.length > 0 ? await layoutsPlacingModules(tx, branchId, moduleIds) : null;

  const placementOfInstances = (ids: readonly string[]) => {
    const pages = new Map<string, PartPage>();
    const lists = new Set<string>();
    let inLayout = false;
    let morePages = false;
    for (const id of ids) {
      const r = reach.get(id);
      if (!r) throw new Error(`loadPartPlacements: no reach for content instance ${id}`);
      for (const p of r.pages) pages.set(p.pageId, p);
      for (const l of r.viaLists) lists.add(l.name);
      if (r.chromeLayouts.length > 0) inLayout = true;
      if (r.morePages) morePages = true;
    }
    return {
      pages: [...pages.values()].sort((a, b) => a.path.localeCompare(b.path)),
      lists: [...lists].sort(),
      inLayout,
      morePages,
    };
  };

  for (const id of instanceIds) {
    out.set(partKey({ kind: "contentInstance", id }), placementOfInstances([id]));
  }
  for (const id of moduleIds) {
    const instances = instancesOf.get(id) ?? [];
    const placed = placementOfInstances(instances);
    out.set(partKey({ kind: "module", id }), {
      ...placed,
      inLayout: placed.inLayout || (chrome?.get(id)?.length ?? 0) > 0,
      morePages: placed.morePages || instances.length > PART_INSTANCE_CAP,
    });
  }
  return out;
}
