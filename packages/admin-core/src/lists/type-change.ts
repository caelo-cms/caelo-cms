// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — what a new list type definition does to entries written
 * under the old one (docs/lists.md §3, "Changing a type that has lists").
 * Pure; the op applies it to every shared and local list of the type.
 *
 * Values for fields, children and query overrides the new definition no
 * longer has — and entries of node kinds it no longer has — are reported
 * as removals: the op refuses them unless the caller passed `dropValues`,
 * in which case they are dropped here. Everything else (new required
 * fields, changed value shapes) is left to `validateListItems`, which
 * fills a new field's `default` into existing entries.
 */

import type { ListItem, ListItemInput, ListTypeDef } from "@caelo-cms/shared";

/** One kind of data the new definition would remove, with how often. */
export interface TypeChangeRemoval {
  readonly what: string;
  readonly count: number;
}

export interface TypeChangeResult {
  /** The entries with removals applied when `dropValues`, else as given. */
  readonly items: ListItemInput[];
  readonly removals: readonly TypeChangeRemoval[];
}

/** Apply the removals a new definition implies to one entry tree. */
export function adaptItemsToType(
  items: readonly ListItem[],
  def: ListTypeDef,
  dropValues: boolean,
): TypeChangeResult {
  const counts = new Map<string, number>();
  const note = (what: string, n = 1): void => {
    counts.set(what, (counts.get(what) ?? 0) + n);
  };
  const countEntries = (it: ListItem): number =>
    1 + (it.children ?? []).reduce((n, c) => n + countEntries(c), 0);

  const walk = (level: readonly ListItem[]): ListItemInput[] => {
    const out: ListItemInput[] = [];
    for (const it of level) {
      const node = def.nodes[it.node];
      if (!node) {
        note(`entries of node kind "${it.node}" (with their children)`, countEntries(it));
        if (!dropValues) out.push(structuredClone(it) as ListItemInput);
        continue;
      }
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(it.values)) {
        if (node.fields.some((f) => f.name === k)) values[k] = v;
        else {
          note(`values of field "${it.node}.${k}"`);
          if (!dropValues) values[k] = v;
        }
      }
      const next: ListItemInput = { id: it.id, node: it.node, values };
      if (it.query !== undefined) {
        if (node.source?.kind === "query") next.query = { ...it.query };
        else {
          note(`query overrides on "${it.node}"`);
          if (!dropValues) next.query = { ...it.query };
        }
      }
      if (it.children && it.children.length > 0) {
        if (node.children) next.children = walk(it.children);
        else {
          note(
            `children of "${it.node}" entries`,
            it.children.reduce((n, c) => n + countEntries(c), 0),
          );
          if (!dropValues) next.children = structuredClone(it.children) as ListItemInput[];
        }
      }
      out.push(next);
    }
    return out;
  };

  const adapted = walk(items);
  return {
    items: adapted,
    removals: [...counts.entries()].map(([what, count]) => ({ what, count })),
  };
}
