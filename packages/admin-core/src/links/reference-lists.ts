// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the list references the reference-integrity check
 * (reference-integrity.ts) follows besides page and media links:
 *
 *   - `caelo:list/<id>`: a module `list` field's shared list (fixed on the
 *     field, its default, or a placement's value) and a `page_terms`
 *     source's vocabulary;
 *   - `caelo:term/<listId>/<itemId>`: page terms, query `terms` (list
 *     entries, list type source defaults, `source` field defaults and
 *     placement overrides) and `term` field values;
 *   - `{ moduleId, contentInstanceId }`: a list entry's `module` field,
 *     which renders that module inside the entry.
 *
 * Pure helpers: they find references in stored values, the check decides
 * what each one means for the pages it renders on. Write-time checks of
 * the same references live with the list ops (`ops/lists/_shared.ts`
 * `checkEntryRefs`); this file covers what breaks AFTER a write — a list,
 * entry or module deleted while still referenced.
 */

import { type ListItem, type ListTypeDef, parseListRef, TERM_REF_RE } from "@caelo-cms/shared";

/** A term reference found in a stored value. */
export interface FoundTermRef {
  readonly ref: string;
  readonly listId: string;
  readonly itemId: string;
}

/** A list entry's embedded module (`module` field value). */
export interface FoundEntryModule {
  readonly moduleId: string;
  readonly contentInstanceId: string;
  /** `entry <itemId>.values.<field>` */
  readonly where: string;
}

/** Most nodes one deep walk visits; stored values are bounded far below this. */
const MAX_WALK = 100_000;

function walkStrings(value: unknown, visit: (s: string) => void): void {
  let budget = MAX_WALK;
  const go = (v: unknown): void => {
    if (budget-- <= 0) return;
    if (typeof v === "string") visit(v);
    else if (Array.isArray(v)) for (const x of v) go(x);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) go(x);
  };
  go(value);
}

/** Every `caelo:list/<id>` string anywhere in `value` (list ids, deduplicated). */
export function collectListRefs(value: unknown): string[] {
  const out = new Set<string>();
  walkStrings(value, (s) => {
    const id = parseListRef(s);
    if (id !== null) out.add(id);
  });
  return [...out];
}

/** Every `caelo:term/<listId>/<itemId>` string anywhere in `value` (deduplicated). */
export function collectTermRefs(value: unknown): FoundTermRef[] {
  const out = new Map<string, FoundTermRef>();
  walkStrings(value, (s) => {
    const m = TERM_REF_RE.exec(s);
    if (m?.[1] && m[2]) out.set(s, { ref: s, listId: m[1], itemId: m[2] });
  });
  return [...out.values()];
}

/** One stored entry with its position, depth-first in render order. */
export interface WalkedEntry {
  readonly item: ListItem;
  /** `entry <id>` — names the entry the way patch_list_items_many addresses it. */
  readonly where: string;
}

/**
 * Every stored entry of a tree. Malformed nodes (not an object, no id) are
 * skipped: rendering reports them as `list-malformed`, and the write ops
 * never store them.
 */
export function walkEntries(items: unknown): WalkedEntry[] {
  const out: WalkedEntry[] = [];
  const go = (level: unknown): void => {
    if (!Array.isArray(level)) return;
    for (const raw of level) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as ListItem;
      if (typeof item.id !== "string") continue;
      out.push({ item, where: `entry ${item.id}` });
      go(item.children);
    }
  };
  go(items);
  return out;
}

/**
 * The modules a tree's entries embed through `module` fields of their
 * node kind (`def` = the tree's list type). Unknown node kinds have no
 * fields and embed nothing.
 */
export function entryModules(def: ListTypeDef, items: unknown): FoundEntryModule[] {
  const out: FoundEntryModule[] = [];
  for (const { item, where } of walkEntries(items)) {
    for (const f of def.nodes[item.node]?.fields ?? []) {
      if (f.type !== "module") continue;
      const v = item.values?.[f.name] as { moduleId?: unknown; contentInstanceId?: unknown };
      if (v === null || typeof v !== "object") continue;
      if (typeof v.moduleId !== "string" || typeof v.contentInstanceId !== "string") continue;
      out.push({
        moduleId: v.moduleId,
        contentInstanceId: v.contentInstanceId,
        where: `${where}.values.${f.name}`,
      });
    }
  }
  return out;
}

/** The ids of every stored entry of a tree. */
export function entryIds(items: unknown): Set<string> {
  return new Set(walkEntries(items).map((e) => e.item.id));
}
