// SPDX-License-Identifier: MPL-2.0

/**
 * The list editor's tree model (epic #1107, `docs/lists.md` §4, §13).
 *
 * Pure functions over an immutable tree so the Svelte components only
 * render and dispatch; every rule about what may go where lives here and
 * is unit-tested (`tree.test.ts`). The rules are the list type's: which
 * node kinds a level allows (`root.allow`, `children.allow`), how many
 * entries a level holds (`max`), and how deep the tree may grow
 * (`effectiveMaxDepth`). A node with a source has generated entries and
 * takes no stored children.
 *
 * Editor entries always carry a `children` array (drag and drop needs one
 * per level); {@link toStored} drops the empty ones again so the stored
 * shape stays the one `validateListItems` defines.
 */

import {
  effectiveMaxDepth,
  type ListItemInput,
  type ListTypeDef,
  type NodeDef,
} from "@caelo-cms/shared";
import { cleanValues, initialValues } from "./field-form.js";

/** One entry as the editor holds it. */
export interface EditorItem {
  id: string;
  node: string;
  values: Record<string, unknown>;
  children: EditorItem[];
  query?: Record<string, unknown>;
}

/** Where an entry sits: the parent entry's id (null = top level) and its index there. */
export interface TreePosition {
  parentId: string | null;
  index: number;
}

/** A refused placement and why, phrased for the operator. */
export type PlaceCheck = { ok: true } | { ok: false; reason: string };

/** Editor tree from stored entries (ids kept; entries without one get a fresh id). */
export function fromStored(
  items: readonly ListItemInput[],
  newId: () => string = () => crypto.randomUUID(),
): EditorItem[] {
  return items.map((it) => ({
    id: it.id ?? newId(),
    node: it.node,
    values: { ...it.values },
    children: fromStored(it.children ?? [], newId),
    ...(it.query !== undefined ? { query: { ...it.query } } : {}),
  }));
}

/** Stored entries from the editor tree. */
export function toStored(items: readonly EditorItem[]): ListItemInput[] {
  return items.map((it) => ({
    id: it.id,
    node: it.node,
    values: { ...it.values },
    ...(it.children.length > 0 ? { children: toStored(it.children) } : {}),
    ...(it.query !== undefined && Object.keys(it.query).length > 0
      ? { query: { ...it.query } }
      : {}),
  }));
}

/**
 * The entries to save: the stored shape with every value coerced and the
 * unset ones dropped (`cleanValues`), so an emptied input removes the value
 * instead of storing `""`.
 */
export function toSavedItems(def: ListTypeDef, items: readonly EditorItem[]): ListItemInput[] {
  return toStored(items).map(function clean(it): ListItemInput {
    const fields = def.nodes[it.node]?.fields ?? [];
    return {
      ...it,
      values: cleanValues(fields, it.values),
      ...(it.children ? { children: it.children.map(clean) } : {}),
    };
  });
}

/** The tree with the level under `parentId` (null = top) replaced by `level`. */
export function replaceLevel(
  items: readonly EditorItem[],
  parentId: string | null,
  level: EditorItem[],
): EditorItem[] {
  return mapLevel(items, parentId, () => level);
}

/** The entry with `id`, or null. */
export function findItem(items: readonly EditorItem[], id: string): EditorItem | null {
  for (const it of items) {
    if (it.id === id) return it;
    const hit = findItem(it.children, id);
    if (hit) return hit;
  }
  return null;
}

/** Where the entry with `id` sits, or null. */
export function positionOf(
  items: readonly EditorItem[],
  id: string,
  parentId: string | null = null,
): TreePosition | null {
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] as EditorItem;
    if (it.id === id) return { parentId, index: i };
    const hit = positionOf(it.children, id, it.id);
    if (hit) return hit;
  }
  return null;
}

/** 1-based depth of the entry with `id` (0 when absent). */
export function depthOf(items: readonly EditorItem[], id: string, depth = 1): number {
  for (const it of items) {
    if (it.id === id) return depth;
    const d = depthOf(it.children, id, depth + 1);
    if (d > 0) return d;
  }
  return 0;
}

/** Levels the entry spans: 1 for a leaf, 1 + its deepest child otherwise. */
export function heightOf(item: EditorItem): number {
  return 1 + item.children.reduce((m, c) => Math.max(m, heightOf(c)), 0);
}

/** Total entries, all levels. */
export function countItems(items: readonly EditorItem[]): number {
  return items.reduce((n, it) => n + 1 + countItems(it.children), 0);
}

/**
 * What a level allows: the node kinds and the entry cap. `parentNode`
 * null = the top level. A node with a source or without `children` takes
 * nothing.
 */
export function levelRule(
  def: ListTypeDef,
  parentNode: string | null,
): { allow: readonly string[]; max: number | undefined } {
  if (parentNode === null) return { allow: def.root.allow, max: def.root.max };
  const node: NodeDef | undefined = def.nodes[parentNode];
  if (!node?.children || node.source) return { allow: [], max: undefined };
  return { allow: node.children.allow, max: node.children.max };
}

/** Label of a node kind, falling back to the kind itself. */
export function nodeLabel(def: ListTypeDef, kind: string): string {
  return def.nodes[kind]?.label ?? kind;
}

function levelItems(items: readonly EditorItem[], parentId: string | null): readonly EditorItem[] {
  if (parentId === null) return items;
  return findItem(items, parentId)?.children ?? [];
}

/**
 * May `item` (already in the tree or new) go under `parentId`? Checks the
 * node kind against the level's `allow`, the level's `max` (the item
 * itself does not count when it already sits there), the depth of the
 * item's whole subtree, and that an entry never moves into itself.
 */
export function canPlace(
  def: ListTypeDef,
  items: readonly EditorItem[],
  item: EditorItem,
  parentId: string | null,
): PlaceCheck {
  const parent = parentId === null ? null : findItem(items, parentId);
  if (parentId !== null && !parent) return { ok: false, reason: "That entry no longer exists." };
  if (parentId !== null && (parentId === item.id || findItem(item.children, parentId))) {
    return { ok: false, reason: "An entry cannot go inside itself." };
  }
  const rule = levelRule(def, parent?.node ?? null);
  if (!rule.allow.includes(item.node)) {
    const where = parent ? `under "${nodeLabel(def, parent.node)}"` : "at the top level";
    if (rule.allow.length === 0) {
      return { ok: false, reason: `"${nodeLabel(def, parent?.node ?? "")}" takes no entries.` };
    }
    return {
      ok: false,
      reason: `"${nodeLabel(def, item.node)}" is not allowed ${where} — allowed: ${rule.allow.map((k) => nodeLabel(def, k)).join(", ")}.`,
    };
  }
  const siblings = levelItems(items, parentId);
  const already = siblings.some((s) => s.id === item.id);
  if (rule.max !== undefined && !already && siblings.length >= rule.max) {
    return { ok: false, reason: `This level holds at most ${rule.max} entries.` };
  }
  const parentDepth = parentId === null ? 0 : depthOf(items, parentId);
  const max = effectiveMaxDepth(def);
  if (parentDepth + heightOf(item) > max) {
    return { ok: false, reason: `This list nests at most ${max} level${max === 1 ? "" : "s"}.` };
  }
  return { ok: true };
}

/** Node kinds that may be added under `parentId` right now (allow + max + depth). */
export function addableKinds(
  def: ListTypeDef,
  items: readonly EditorItem[],
  parentId: string | null,
): string[] {
  const parent = parentId === null ? null : findItem(items, parentId);
  return levelRule(def, parent?.node ?? null).allow.filter(
    (k) => canPlace(def, items, newItem(def, k, "probe"), parentId).ok,
  );
}

/** A new entry of `node` with the fields' defaults. */
export function newItem(
  def: ListTypeDef,
  node: string,
  id: string = crypto.randomUUID(),
): EditorItem {
  return { id, node, values: initialValues(def.nodes[node]?.fields ?? []), children: [] };
}

function mapLevel(
  items: readonly EditorItem[],
  parentId: string | null,
  fn: (level: EditorItem[]) => EditorItem[],
): EditorItem[] {
  if (parentId === null) return fn([...items]);
  return items.map((it) =>
    it.id === parentId
      ? { ...it, children: fn([...it.children]) }
      : { ...it, children: mapLevel(it.children, parentId, fn) },
  );
}

function without(items: readonly EditorItem[], id: string): EditorItem[] {
  return items
    .filter((it) => it.id !== id)
    .map((it) => ({ ...it, children: without(it.children, id) }));
}

/** Insert `item` under `parentId` at `index` (end when absent). */
export function insertItem(
  items: readonly EditorItem[],
  item: EditorItem,
  parentId: string | null,
  index?: number,
): EditorItem[] {
  return mapLevel(items, parentId, (level) => {
    const at = index === undefined ? level.length : Math.max(0, Math.min(index, level.length));
    level.splice(at, 0, item);
    return level;
  });
}

/** Remove the entry `id` (and its children). */
export function removeItem(items: readonly EditorItem[], id: string): EditorItem[] {
  return without(items, id);
}

/** Replace the entry `id` with `patch` applied. */
export function updateItem(
  items: readonly EditorItem[],
  id: string,
  patch: (it: EditorItem) => EditorItem,
): EditorItem[] {
  return items.map((it) =>
    it.id === id ? patch(it) : { ...it, children: updateItem(it.children, id, patch) },
  );
}

/**
 * Move the entry `id` under `parentId` at `index` (an index in the level
 * as it is WITHOUT the moved entry). Returns the unchanged tree with the
 * reason when the type does not allow it.
 */
export function moveItem(
  def: ListTypeDef,
  items: readonly EditorItem[],
  id: string,
  parentId: string | null,
  index: number,
): { items: EditorItem[]; check: PlaceCheck } {
  const item = findItem(items, id);
  if (!item) return { items: [...items], check: { ok: false, reason: "Entry not found." } };
  const rest = without(items, id);
  const check = canPlace(def, rest, item, parentId);
  if (!check.ok) return { items: [...items], check };
  return { items: insertItem(rest, item, parentId, index), check };
}

/** Swap the entry with its previous (`-1`) or next (`+1`) sibling. */
export function shiftItem(
  def: ListTypeDef,
  items: readonly EditorItem[],
  id: string,
  delta: -1 | 1,
): { items: EditorItem[]; check: PlaceCheck } {
  const pos = positionOf(items, id);
  if (!pos) return { items: [...items], check: { ok: false, reason: "Entry not found." } };
  const target = pos.index + delta;
  const size = levelItems(items, pos.parentId).length;
  if (target < 0 || target >= size) {
    return { items: [...items], check: { ok: false, reason: "Already at the edge." } };
  }
  return moveItem(def, items, id, pos.parentId, target);
}

/** Make the entry the last child of its previous sibling. */
export function indentItem(
  def: ListTypeDef,
  items: readonly EditorItem[],
  id: string,
): { items: EditorItem[]; check: PlaceCheck } {
  const pos = positionOf(items, id);
  const prev = pos && pos.index > 0 ? levelItems(items, pos.parentId)[pos.index - 1] : undefined;
  if (!prev) {
    return {
      items: [...items],
      check: { ok: false, reason: "There is no entry above to nest this one under." },
    };
  }
  return moveItem(def, items, id, prev.id, prev.children.length);
}

/** Move the entry out of its parent, right after the parent. */
export function outdentItem(
  def: ListTypeDef,
  items: readonly EditorItem[],
  id: string,
): { items: EditorItem[]; check: PlaceCheck } {
  const pos = positionOf(items, id);
  if (!pos || pos.parentId === null) {
    return { items: [...items], check: { ok: false, reason: "Already at the top level." } };
  }
  const parentPos = positionOf(items, pos.parentId);
  if (!parentPos) return { items: [...items], check: { ok: false, reason: "Entry not found." } };
  return moveItem(def, items, id, parentPos.parentId, parentPos.index + 1);
}

/**
 * Structural problems of a whole tree (node placement, `max`, depth) —
 * what a drag that bypassed {@link canPlace} would have broken. Values
 * are not checked here; the save validates them.
 */
export function structureIssues(def: ListTypeDef, items: readonly EditorItem[]): string[] {
  const issues: string[] = [];
  const max = effectiveMaxDepth(def);
  const walk = (level: readonly EditorItem[], parentNode: string | null, depth: number): void => {
    const rule = levelRule(def, parentNode);
    if (rule.max !== undefined && level.length > rule.max) {
      issues.push(`A level holds ${level.length} entries; at most ${rule.max} are allowed.`);
    }
    for (const it of level) {
      if (!rule.allow.includes(it.node)) {
        issues.push(
          `"${nodeLabel(def, it.node)}" is not allowed ${parentNode ? `under "${nodeLabel(def, parentNode)}"` : "at the top level"}.`,
        );
      }
      if (depth > max) issues.push(`The list nests deeper than ${max} levels.`);
      walk(it.children, it.node, depth + 1);
    }
  };
  walk(items, null, 1);
  return issues;
}
