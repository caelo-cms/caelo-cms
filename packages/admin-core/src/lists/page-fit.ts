// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — does a page fit its page type (docs/lists.md §5)?
 *
 * One check for every writer of a page's type, template, properties or
 * terms: pages.create / update / update_many and page_types.upsert_many
 * (which re-checks every page of a changed type). The template must be one
 * of the type's templates; properties are validated with the shared field
 * system (a missing value takes the property's `default`); terms must be
 * entries of the type's vocabulary lists, with the cardinality and
 * `required` the type declares. Every problem comes back as one sentence
 * the AI can act on.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type PageTypeDef, validateFieldValue } from "@caelo-cms/shared";
import { parseTermRef } from "./page-terms.js";
import { loadListEntities } from "./store.js";

/** A page's type-bound state, as written. */
export interface PageTypeBound {
  readonly templateId: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly terms: readonly string[];
}

export interface PageFit {
  /** Properties with defaults filled in (unknown keys kept, and reported). */
  readonly properties: Record<string, unknown>;
  /** Terms in the order given, duplicates removed. */
  readonly terms: string[];
  readonly issues: string[];
}

/** Vocabulary entry ids per list id (lists the caller sees), for repeated checks. */
export type VocabularyIndex = ReadonlyMap<string, { slug: string; itemIds: ReadonlySet<string> }>;

/** Load the vocabulary lists `defs` name, as the caller sees them. */
export async function loadVocabularyIndex(
  tx: TransactionRunner,
  branchId: string | null,
  defs: readonly PageTypeDef[],
): Promise<VocabularyIndex> {
  const ids = [...new Set(defs.flatMap((d) => d.vocabularies.map((v) => v.list)))];
  const out = new Map<string, { slug: string; itemIds: Set<string> }>();
  for (const l of await loadListEntities(tx, "list", branchId, { ids })) {
    const itemIds = new Set<string>();
    const go = (items: typeof l.state.items): void => {
      for (const it of items) {
        itemIds.add(it.id);
        if (it.children) go(it.children);
      }
    };
    go(l.state.items);
    out.set(l.id, { slug: l.state.slug, itemIds });
  }
  return out;
}

/** Check (and normalise) a page's type-bound state against `def`. */
export function fitPageToType(
  def: PageTypeDef,
  page: PageTypeBound,
  vocabularies: VocabularyIndex,
): PageFit {
  const issues: string[] = [];
  if (!def.templates.includes(page.templateId)) {
    issues.push(
      `template ${page.templateId} is not one of page type "${def.slug}"'s templates (${def.templates.join(", ")}) — pass one of those as templateId, or add the template to the page type (page_types.upsert_many).`,
    );
  }
  const properties: Record<string, unknown> = {};
  for (const f of def.properties) {
    const v = Object.hasOwn(page.properties, f.name) ? page.properties[f.name] : f.default;
    for (const i of validateFieldValue(f, v, `properties.${f.name}`)) {
      issues.push(`${i.path}: ${i.message}`);
    }
    if (v !== undefined && v !== null) properties[f.name] = v;
  }
  for (const k of Object.keys(page.properties)) {
    if (def.properties.some((f) => f.name === k)) continue;
    issues.push(
      `properties.${k}: page type "${def.slug}" declares no property "${k}" — it has ${def.properties.map((f) => f.name).join(", ") || "none"}. Drop it (pass ${k}: null) or add it to the page type.`,
    );
    properties[k] = page.properties[k];
  }

  const terms = [...new Set(page.terms)];
  const perList = new Map<string, number>();
  for (const ref of terms) {
    const t = parseTermRef(ref);
    if (!t) {
      issues.push(`terms: "${ref}" is not a term reference — use caelo:term/<listId>/<entryId>.`);
      continue;
    }
    const vocab = def.vocabularies.find((v) => v.list === t.listId);
    if (!vocab) {
      issues.push(
        `terms: "${ref}" is from list ${t.listId}, which is not a vocabulary of page type "${def.slug}" — its vocabularies are ${def.vocabularies.map((v) => vocabularies.get(v.list)?.slug ?? v.list).join(", ") || "none"}.`,
      );
      continue;
    }
    const index = vocabularies.get(t.listId);
    if (!index?.itemIds.has(t.itemId)) {
      issues.push(
        `terms: "${ref}" names no entry of vocabulary "${index?.slug ?? t.listId}" — read the list (lists.get) for its entry ids, or add the term first (lists.patch_items_many).`,
      );
      continue;
    }
    perList.set(t.listId, (perList.get(t.listId) ?? 0) + 1);
  }
  for (const v of def.vocabularies) {
    const n = perList.get(v.list) ?? 0;
    const slug = vocabularies.get(v.list)?.slug ?? v.list;
    if (v.cardinality === "one" && n > 1) {
      issues.push(`terms: page type "${def.slug}" takes one term of "${slug}", got ${n}.`);
    }
    if (v.required && n === 0) {
      issues.push(
        `terms: page type "${def.slug}" requires a term of "${slug}" — pick one from that list.`,
      );
    }
  }
  return { properties, terms, issues };
}
