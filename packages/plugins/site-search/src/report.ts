// SPDX-License-Identifier: MPL-2.0

/**
 * The module counting report's writes (`module_counting`, shown by the
 * `index_report` operation): what one observer call changes in it.
 *
 * Every observer call reports how each module of its pages counts, and a
 * Stage that delivers the whole site makes one call per batch of pages, so
 * the site's chrome and its shared sections are reported by every call.
 * Writing each reported row back made a full delivery thousands of
 * private-storage writes, each its own snapshot: on searchVIU (2026-11-26,
 * 325 pages, 201 modules) about 2,400 per Stage, 4 to 11 minutes of the
 * Stage's page-output phase on a small database. A row is written only when
 * what the report shows of it changed, and rows that change the same way
 * go in one `updateMany`.
 */

import type { ModuleReportRow } from "./observe.js";

/** A module's stored report row (`module_counting`). */
export interface StoredModuleRow {
  readonly id: string;
  readonly module_id: string;
  readonly name: string;
  readonly zone: string;
  readonly placement: number;
  readonly weighting: string;
  readonly reason: string;
  /** The Stage whose observer last changed the row. */
  readonly run_id: string;
}

/** What one observer call writes to `module_counting`. */
export interface ModuleReportWrites {
  readonly inserts: readonly Omit<StoredModuleRow, "id">[];
  /** One `updateMany` each: the rows that change the same way. */
  readonly updates: readonly {
    readonly ids: readonly string[];
    readonly patch: Readonly<Record<string, unknown>>;
  }[];
}

/** The columns the report shows, in a fixed order (it keys the grouping). */
const SHOWN = ["module_id", "name", "zone", "placement", "weighting", "reason"] as const;

/**
 * The writes that bring the stored rows to what `modules` report in Stage
 * `runId`. A module without a row gets one; a row whose shown columns
 * already say the same is left alone. A module's verdict differs only on
 * its home page, and the report shows how it counts on the other pages
 * (observe.ts): a home-page verdict never replaces a verdict this Stage
 * already wrote, whichever batch of pages comes first.
 *
 * @param stored the module's rows, by module id
 */
export function moduleReportWrites(
  stored: ReadonlyMap<string, StoredModuleRow>,
  modules: readonly ModuleReportRow[],
  runId: string,
): ModuleReportWrites {
  const inserts: Omit<StoredModuleRow, "id">[] = [];
  const updates = new Map<string, { ids: string[]; patch: Record<string, unknown> }>();
  for (const m of modules) {
    const shown = {
      module_id: m.moduleId,
      name: m.name,
      zone: m.zone,
      placement: m.placement,
      weighting: m.weighting,
      reason: m.reason,
    };
    const row = stored.get(m.moduleId);
    if (!row) {
      inserts.push({ ...shown, run_id: runId });
      continue;
    }
    if (m.reason === "home-page" && row.run_id === runId && row.reason !== "home-page") continue;
    const patch: Record<string, unknown> = {};
    for (const column of SHOWN) if (row[column] !== shown[column]) patch[column] = shown[column];
    if (Object.keys(patch).length === 0) continue;
    patch.run_id = runId;
    const key = JSON.stringify(patch);
    const group = updates.get(key) ?? { ids: [], patch };
    group.ids.push(row.id);
    updates.set(key, group);
  }
  return { inserts, updates: [...updates.values()] };
}
