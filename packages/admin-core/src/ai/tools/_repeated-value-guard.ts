// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1062 — write-time hint for the same value copied into many
 * private content instances of one module.
 *
 * A build that places one module on 30 pages with inline content gives
 * every placement its own (unsynced) instance. When most fields carry the
 * same text on every page, one sentence changed later means 30 rewrites.
 * After a content write, a field value that is now identical on three or
 * more private instances of the same module gets a hint: make it shared
 * content (one synced instance) or, if it is the same on every page, part
 * of the module's HTML — values that never differ are not fields.
 *
 * A warning on an already-successful write, never a gate (same contract
 * as the markup guard it rides with).
 */

/** Copies of one value (private instances of one module) that trigger the hint. */
export const REPEATED_VALUE_MIN_COPIES = 3;

/**
 * Shortest value worth a hint. A short label ("Learn more", "#") repeating
 * across cards is normal; the hint is about copied prose and lists.
 */
const MIN_VALUE_LENGTH = 20;

/** A content instance as the repeated-value guard sees it. */
export interface ValueInstance {
  readonly id: string;
  readonly moduleId: string;
  readonly moduleDisplayName: string;
  readonly placementCount: number;
  readonly values: Readonly<Record<string, unknown>>;
}

/** The value's comparison key, or null when it is too small to matter. */
function valueKey(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim().length >= MIN_VALUE_LENGTH ? JSON.stringify(value.trim()) : null;
  }
  if (Array.isArray(value) && value.length > 0) {
    const key = JSON.stringify(value);
    // Nested module refs point at per-placement instances; never equal copies.
    if (key.includes("contentInstanceId") || key.includes('"$ref"')) return null;
    return key.length >= MIN_VALUE_LENGTH ? key : null;
  }
  return null;
}

/** Whether a write carries any value the guard could hint about. */
export function hasRepeatCandidates(
  written: readonly Readonly<Record<string, unknown>>[],
): boolean {
  return written.some((v) => Object.values(v).some((x) => valueKey(x) !== null));
}

/**
 * Hints for a content write, judged on the state AFTER the write: for each
 * written field value, the private instances (at most one placement) of
 * one module that now hold exactly that value.
 */
export function repeatedValueHints(
  written: readonly Readonly<Record<string, unknown>>[],
  instances: readonly ValueInstance[],
): string[] {
  const wanted = new Set<string>();
  for (const values of written) {
    for (const [field, value] of Object.entries(values)) {
      const key = valueKey(value);
      if (key !== null) wanted.add(`${field}\u0000${key}`);
    }
  }
  if (wanted.size === 0) return [];
  const copies = new Map<string, { field: string; module: string; ids: string[] }>();
  for (const inst of instances) {
    if (inst.placementCount > 1) continue; // already shared
    for (const [field, value] of Object.entries(inst.values)) {
      const key = valueKey(value);
      if (key === null || !wanted.has(`${field}\u0000${key}`)) continue;
      const group = `${inst.moduleId}\u0000${field}\u0000${key}`;
      const entry = copies.get(group) ?? { field, module: inst.moduleDisplayName, ids: [] };
      entry.ids.push(inst.id);
      copies.set(group, entry);
    }
  }
  const byModule = new Map<string, { module: string; fields: string[]; count: number }>();
  for (const [group, c] of copies) {
    if (c.ids.length < REPEATED_VALUE_MIN_COPIES) continue;
    const moduleId = group.split("\u0000")[0] as string;
    const m = byModule.get(moduleId) ?? { module: c.module, fields: [], count: 0 };
    if (!m.fields.includes(c.field)) m.fields.push(c.field);
    m.count = Math.max(m.count, c.ids.length);
    byModule.set(moduleId, m);
  }
  return [...byModule.entries()].map(
    ([moduleId, m]) =>
      `${m.fields.map((f) => `\`${f}\``).join(", ")} of module "${m.module}" (${moduleId}) now hold the same value in ${m.count} separate private copies — one change later means ${m.count} rewrites. If the value is the same on every page, put it into the module's HTML (edit_module) instead of a field; if the whole section repeats, bind the placements to ONE shared instance (create_content_instance + set_placement_content with syncMode "synced")`,
  );
}
