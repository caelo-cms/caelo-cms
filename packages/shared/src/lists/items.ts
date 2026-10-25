// SPDX-License-Identifier: MPL-2.0

/**
 * List entries — storage shape, validation against a list type, and the
 * pure item-level patch operations (epic #1107, `docs/lists.md` §4).
 *
 * A shared list and a local list (a module field value) store the same
 * array. Children always live under `children` in storage; the loop name
 * a template uses (`children.name` on the node) is a rendering concern,
 * so renaming a loop never rewrites stored data.
 *
 * Every entry carries a UUID that never changes, also not on a move.
 * Diffs, translations (by address, `address.ts`) and page terms
 * (`caelo:term/<listId>/<itemId>`) hang off it.
 */

import { z } from "zod";
import { type ListIssue, validateFieldValue } from "./fields.js";
import {
  effectiveMaxDepth,
  LIST_MAX_ITEMS,
  type ListTypeDef,
  pageQueryPartialSchema,
} from "./list-type.js";

export interface ListItem {
  readonly id: string;
  readonly node: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly children?: readonly ListItem[];
  readonly query?: Readonly<Record<string, unknown>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Input shape: `id` optional (assigned on write). Recursive. */
export const listItemInputSchema: z.ZodType<ListItemInput> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(UUID_RE, "id must be a lowercase uuid").optional(),
      node: z.string().min(1).max(64),
      values: z.record(z.string(), z.unknown()).default({}),
      children: z.array(listItemInputSchema).optional(),
      query: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
);
export interface ListItemInput {
  id?: string;
  node: string;
  values: Record<string, unknown>;
  children?: ListItemInput[];
  query?: Record<string, unknown>;
}

export interface ValidateItemsOptions {
  /** Mints ids for new entries; injectable for deterministic tests. */
  readonly newId?: () => string;
  /** Path prefix for issues (`items` by default). */
  readonly path?: string;
}

export interface ValidatedItems {
  readonly items: ListItem[];
  readonly issues: ListIssue[];
}

/**
 * Validate entries against `type`, assigning ids to entries without one.
 * Checks node placement, required fields and value shapes, depth, per-level
 * `max`, the total count, duplicate ids, and query overrides (only the
 * source's `editable` knobs). Values for fields a node does not declare
 * are an issue — data the type does not know about would be invisible in
 * the editor and silently dropped by the next full replace.
 */
export function validateListItems(
  type: ListTypeDef,
  input: unknown,
  opts: ValidateItemsOptions = {},
): ValidatedItems {
  const root = opts.path ?? "items";
  const issues: ListIssue[] = [];
  const parsed = z.array(listItemInputSchema).safeParse(input);
  if (!parsed.success) {
    return {
      items: [],
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: `${root}${i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")}`,
        message: i.message,
      })),
    };
  }
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const maxDepth = effectiveMaxDepth(type);
  const ids = new Set<string>();
  let count = 0;

  const walk = (
    items: readonly ListItemInput[],
    allow: readonly string[],
    max: number | undefined,
    depth: number,
    path: string,
  ): ListItem[] => {
    if (max !== undefined && items.length > max) {
      issues.push({ path, message: `at most ${max} entries allowed here, got ${items.length}.` });
    }
    return items.map((it, i) => {
      const at = `${path}[${i}]`;
      count += 1;
      const id = it.id ?? newId();
      if (ids.has(id)) issues.push({ path: `${at}.id`, message: `duplicate entry id ${id}.` });
      ids.add(id);
      const node = type.nodes[it.node];
      if (!node) {
        issues.push({
          path: `${at}.node`,
          message: `unknown node kind "${it.node}" — the type defines ${Object.keys(type.nodes).join(", ")}.`,
        });
        return { id, node: it.node, values: it.values };
      }
      if (!allow.includes(it.node)) {
        issues.push({
          path: `${at}.node`,
          message: `"${it.node}" is not allowed here — allowed: ${allow.join(", ")}.`,
        });
      }
      if (depth > maxDepth) {
        issues.push({ path: at, message: `nesting deeper than ${maxDepth} levels.` });
      }
      const values: Record<string, unknown> = {};
      for (const f of node.fields) {
        const v = Object.hasOwn(it.values, f.name) ? it.values[f.name] : f.default;
        issues.push(...validateFieldValue(f, v, `${at}.values.${f.name}`));
        if (v !== undefined) values[f.name] = v;
      }
      for (const k of Object.keys(it.values)) {
        if (!node.fields.some((f) => f.name === k)) {
          issues.push({
            path: `${at}.values.${k}`,
            message: `node "${it.node}" has no field "${k}" — add the field to the type or drop the value.`,
          });
        }
      }
      const out: {
        id: string;
        node: string;
        values: Record<string, unknown>;
        children?: ListItem[];
        query?: Record<string, unknown>;
      } = {
        id,
        node: it.node,
        values,
      };
      if (it.query !== undefined) {
        if (node.source?.kind !== "query") {
          issues.push({ path: `${at}.query`, message: `node "${it.node}" has no query source.` });
        } else {
          const q = pageQueryPartialSchema.safeParse(it.query);
          if (!q.success) {
            issues.push({
              path: `${at}.query`,
              message: `invalid query: ${q.error.issues[0]?.message ?? ""}`,
            });
          }
          for (const k of Object.keys(it.query)) {
            if (!(node.source.editable as readonly string[]).includes(k)) {
              issues.push({
                path: `${at}.query.${k}`,
                message: `"${k}" is not editable on "${it.node}" — editable: ${node.source.editable.join(", ") || "none"}.`,
              });
            }
          }
          out.query = it.query;
        }
      }
      if (it.children !== undefined && it.children.length > 0) {
        if (!node.children) {
          issues.push({ path: `${at}.children`, message: `node "${it.node}" takes no children.` });
        } else {
          out.children = walk(
            it.children,
            node.children.allow,
            node.children.max,
            depth + 1,
            `${at}.children`,
          );
        }
      }
      return out;
    });
  };

  const items = walk(parsed.data, type.root.allow, type.root.max, 1, root);
  if (count > LIST_MAX_ITEMS) {
    issues.push({
      path: root,
      message: `a list holds at most ${LIST_MAX_ITEMS} entries, got ${count}.`,
    });
  }
  return { items, issues };
}

/** Depth-first visit of every entry with its parent id and depth (1-based). */
export function walkListItems(
  items: readonly ListItem[],
  visit: (item: ListItem, parentId: string | null, depth: number, index: number) => void,
): void {
  const go = (level: readonly ListItem[], parentId: string | null, depth: number): void => {
    level.forEach((it, i) => {
      visit(it, parentId, depth, i);
      if (it.children) go(it.children, it.id, depth + 1);
    });
  };
  go(items, null, 1);
}

/** Find an entry by id anywhere in the tree. */
export function findListItem(items: readonly ListItem[], id: string): ListItem | null {
  let hit: ListItem | null = null;
  walkListItems(items, (it) => {
    if (hit === null && it.id === id) hit = it;
  });
  return hit;
}

export type ListItemPatch =
  | {
      readonly op: "add";
      readonly parentId?: string | null;
      readonly position?: number;
      readonly item: ListItemInput;
    }
  | {
      readonly op: "update";
      readonly itemId: string;
      /** Merged into the entry's values; `null` removes a value. */
      readonly values?: Readonly<Record<string, unknown>>;
      readonly query?: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly op: "move";
      readonly itemId: string;
      readonly parentId?: string | null;
      readonly position: number;
    }
  | { readonly op: "remove"; readonly itemId: string };

/**
 * Apply item-level patches to a tree. Pure; the result still needs
 * {@link validateListItems}. Throws {@link ListPatchError} when a patch
 * names an entry that does not exist (or moves an entry into itself).
 */
export function applyListItemPatches(
  items: readonly ListItem[],
  patches: readonly ListItemPatch[],
): ListItemInput[] {
  const tree: ListItemInput[] = structuredClone(items as ListItem[]) as ListItemInput[];
  patches.forEach((p, i) => {
    const at = `patches[${i}]`;
    switch (p.op) {
      case "add": {
        const level = levelOf(tree, p.parentId ?? null, at);
        insertAt(level, structuredClone(p.item), p.position);
        break;
      }
      case "update": {
        const hit = locate(tree, p.itemId);
        if (!hit) throw new ListPatchError(at, `no entry with id ${p.itemId}.`);
        const entry = hit.level[hit.index] as ListItemInput;
        const values = { ...entry.values };
        for (const [k, v] of Object.entries(p.values ?? {})) {
          if (v === null) delete values[k];
          else values[k] = v;
        }
        entry.values = values;
        if (p.query === null) delete entry.query;
        else if (p.query !== undefined) entry.query = { ...p.query };
        break;
      }
      case "move": {
        const hit = locate(tree, p.itemId);
        if (!hit) throw new ListPatchError(at, `no entry with id ${p.itemId}.`);
        const [moved] = hit.level.splice(hit.index, 1) as [ListItemInput];
        if (p.parentId && (p.parentId === p.itemId || containsId(moved, p.parentId))) {
          throw new ListPatchError(at, "an entry cannot move into itself or its own children.");
        }
        insertAt(levelOf(tree, p.parentId ?? null, at), moved, p.position);
        break;
      }
      case "remove": {
        const hit = locate(tree, p.itemId);
        if (!hit) throw new ListPatchError(at, `no entry with id ${p.itemId}.`);
        hit.level.splice(hit.index, 1);
        break;
      }
    }
  });
  return tree;

  function levelOf(t: ListItemInput[], parentId: string | null, at: string): ListItemInput[] {
    if (parentId === null) return t;
    const hit = locate(t, parentId);
    if (!hit) throw new ListPatchError(at, `no parent entry with id ${parentId}.`);
    const parent = hit.level[hit.index] as ListItemInput;
    parent.children ??= [];
    return parent.children;
  }
}

/** A patch that cannot apply (unknown id, move into itself). */
export class ListPatchError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
    this.name = "ListPatchError";
  }
}

function insertAt(level: ListItemInput[], item: ListItemInput, position: number | undefined): void {
  const pos = position === undefined ? level.length : Math.max(0, Math.min(position, level.length));
  level.splice(pos, 0, item);
}

function locate(
  level: ListItemInput[],
  id: string,
): { level: ListItemInput[]; index: number } | null {
  for (let i = 0; i < level.length; i += 1) {
    const it = level[i] as ListItemInput;
    if (it.id === id) return { level, index: i };
    if (it.children) {
      const hit = locate(it.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

function containsId(item: ListItemInput, id: string): boolean {
  return (item.children ?? []).some((c) => c.id === id || containsId(c, id));
}

/** Per-entry change between two versions of a tree (domain events, `docs/lists.md` §9). */
export type ListItemChange =
  | { readonly kind: "added"; readonly itemId: string }
  | {
      readonly kind: "updated";
      readonly itemId: string;
      readonly fields: readonly string[];
      readonly before: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "moved"; readonly itemId: string }
  | { readonly kind: "removed"; readonly itemId: string };

/** Diff two trees by entry id. Deterministic order: removed, added, updated, moved. */
export function diffListItems(
  before: readonly ListItem[],
  after: readonly ListItem[],
): ListItemChange[] {
  const index = (items: readonly ListItem[]) => {
    const m = new Map<string, { item: ListItem; parentId: string | null; position: number }>();
    walkListItems(items, (item, parentId, _d, position) =>
      m.set(item.id, { item, parentId, position }),
    );
    return m;
  };
  const a = index(before);
  const b = index(after);
  const out: ListItemChange[] = [];
  for (const id of a.keys()) if (!b.has(id)) out.push({ kind: "removed", itemId: id });
  for (const id of b.keys()) if (!a.has(id)) out.push({ kind: "added", itemId: id });
  for (const [id, next] of b) {
    const prev = a.get(id);
    if (!prev) continue;
    const keys = new Set([...Object.keys(prev.item.values), ...Object.keys(next.item.values)]);
    const fields = [...keys].filter(
      (k) => JSON.stringify(prev.item.values[k]) !== JSON.stringify(next.item.values[k]),
    );
    if (JSON.stringify(prev.item.query ?? null) !== JSON.stringify(next.item.query ?? null)) {
      fields.push("query");
    }
    if (fields.length > 0) {
      out.push({ kind: "updated", itemId: id, fields, before: prev.item.values });
    }
    if (prev.parentId !== next.parentId || prev.position !== next.position) {
      out.push({ kind: "moved", itemId: id });
    }
  }
  return out;
}
