// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1645) — the merge patch the generated settings form sends:
 * only what changed, groups nested, a map key that was removed as null
 * (which the host reads as "back to the default").
 */

/** Reads a dotted path out of a nested value. */
export function valueAt(values: Readonly<Record<string, unknown>>, path: string): unknown {
  let at: unknown = values;
  for (const part of path.split(".")) at = (at as Record<string, unknown> | undefined)?.[part];
  return at;
}

/** Writes a dotted path into a nested value, creating groups on the way. */
export function setAt(values: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let at = values;
  for (const part of parts.slice(0, -1)) {
    if (typeof at[part] !== "object" || at[part] === null) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  at[parts[parts.length - 1] as string] = value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The patch from `before` to `after` for the given leaves. A `map` leaf
 * becomes a per-key patch: changed and added keys with their value, removed
 * keys as null.
 */
export function configPatch(
  leaves: readonly { readonly path: string; readonly type: string }[],
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const leaf of leaves) {
    const b = valueAt(before, leaf.path);
    const a = valueAt(after, leaf.path);
    if (same(a, b)) continue;
    if (leaf.type === "map") {
      const bm = (b ?? {}) as Record<string, unknown>;
      const am = (a ?? {}) as Record<string, unknown>;
      const delta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(am)) if (!same(v, bm[k])) delta[k] = v;
      for (const k of Object.keys(bm)) if (!(k in am)) delta[k] = null;
      if (Object.keys(delta).length > 0) setAt(patch, leaf.path, delta);
    } else setAt(patch, leaf.path, a);
  }
  return patch;
}
