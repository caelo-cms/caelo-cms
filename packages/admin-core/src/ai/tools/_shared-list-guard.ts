// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — write-time hint for navigation kept twice: the early half
 * of the structure check's `structure/duplicate-navigation` rule
 * (quality/checks/structure.ts).
 *
 * A header and a footer that each keep the same menu as a LOCAL list (or
 * a field default of a chrome module) drift apart the first time one of
 * them is edited. The moment a write makes two modules carry the same
 * links is the moment to say: keep them in ONE shared list and bind both.
 * A warning on an already-successful write, never a gate — the quality
 * check blocks Publish live on it.
 *
 * Compared on the read side's humanised links (`/pricing`, as list ops
 * return them), the form the AI writes in.
 */

/** Fewer links than this are no navigation worth sharing (mirrors MIN_LINK_GROUP). */
const MIN_SHARED_LINKS = 3;

/** One module's list value (a placement's value or a field default). */
export interface ListCarrier {
  readonly moduleId: string;
  readonly moduleName: string;
  /** The list field holding the links. */
  readonly field: string;
  readonly value: unknown;
}

/**
 * The hrefs of a local list value (entries with `values`, children
 * included), sorted and distinct; null when `value` is not a list of
 * entries. A shared binding (`caelo:list/<id>`) is a string, never a
 * local list.
 */
export function listValueHrefs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  let entries = 0;
  const hrefsIn = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) hrefsIn(x);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "href" && typeof x === "string" && x.trim().length > 0) out.add(x.trim());
        else hrefsIn(x);
      }
    }
  };
  const walk = (level: unknown): void => {
    if (!Array.isArray(level)) return;
    for (const e of level) {
      if (e === null || typeof e !== "object" || !("values" in e)) continue;
      entries++;
      hrefsIn((e as { values: unknown }).values);
      walk((e as { children?: unknown }).children);
    }
  };
  walk(value);
  return entries === 0 ? null : [...out].sort();
}

/** The list-field values of a module's fields (defaults) and of instances' values. */
export function carriersOf(
  modules: readonly { id: string; displayName: string; fields?: readonly unknown[] }[],
  instances: readonly {
    moduleId: string;
    moduleDisplayName: string;
    values: Readonly<Record<string, unknown>>;
  }[],
): ListCarrier[] {
  const out: ListCarrier[] = [];
  const listFields = new Map<string, Set<string>>();
  for (const m of modules) {
    const names = new Set<string>();
    for (const f of m.fields ?? []) {
      const field = f as { name?: unknown; kind?: unknown; default?: unknown };
      if (field.kind !== "list" || typeof field.name !== "string") continue;
      names.add(field.name);
      if (field.default !== undefined) {
        out.push({
          moduleId: m.id,
          moduleName: m.displayName,
          field: field.name,
          value: field.default,
        });
      }
    }
    listFields.set(m.id, names);
  }
  for (const i of instances) {
    for (const name of listFields.get(i.moduleId) ?? []) {
      if (Object.hasOwn(i.values, name)) {
        out.push({
          moduleId: i.moduleId,
          moduleName: i.moduleDisplayName,
          field: name,
          value: i.values[name],
        });
      }
    }
  }
  return out;
}

/**
 * Hints for the link sets `written` names (list values just written, as
 * `{field, value}`) that, after the write, two or more modules carry as
 * their own copies (`carriers` include the written ones).
 */
export function sharedListHints(
  written: readonly { field: string; value: unknown }[],
  carriers: readonly ListCarrier[],
): string[] {
  const sigOf = (hrefs: readonly string[]) => hrefs.join("\u0000");
  const bySig = new Map<string, ListCarrier[]>();
  for (const c of carriers) {
    const hrefs = listValueHrefs(c.value);
    if (!hrefs || hrefs.length < MIN_SHARED_LINKS) continue;
    const sig = sigOf(hrefs);
    bySig.set(sig, [...(bySig.get(sig) ?? []), c]);
  }
  const hints: string[] = [];
  const said = new Set<string>();
  for (const w of written) {
    const hrefs = listValueHrefs(w.value);
    if (!hrefs || hrefs.length < MIN_SHARED_LINKS) continue;
    const sig = sigOf(hrefs);
    if (said.has(sig)) continue;
    const same = bySig.get(sig) ?? [];
    const modules = new Map(same.map((c) => [c.moduleId, c]));
    if (modules.size < 2) continue;
    said.add(sig);
    const names = [...modules.values()].map((c) => `"${c.moduleName}" (field \`${c.field}\`)`);
    hints.push(
      `field \`${w.field}\` keeps the same ${hrefs.length} links as ${names.length - 1} other module(s) — ${names.join(", ")} each carry their own copy, and copies of a menu drift apart: keep the links in ONE shared list (promote_local_list on one of these fields) and bind the other modules' list fields to the same caelo:list/<id> (bind "shared"); duplicate navigation blocks Publish live in the structure quality check`,
    );
  }
  return hints;
}
