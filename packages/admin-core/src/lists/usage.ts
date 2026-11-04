// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — where a shared list is used, as the caller sees the site
 * (docs/lists.md §12 `lists.list` usage; CLAUDE.md §1A decision support):
 * the modules whose `list` field binds it, the placements whose value
 * points at it, a few pages that show it, the page types that use it as a
 * vocabulary and how many pages carry its terms. The same reading backs
 * the "refused while bound" rule of `lists.delete_many`.
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { countPlacementsInView } from "../ops/content/content-instance-reach.js";
import { findContentInstancesContaining, idNeedles } from "../ops/content/content-instance-refs.js";
import { countPagesTaggedWithLists, listFieldsOf, loadModulesInView } from "./local.js";
import { loadListEntities } from "./store.js";

/** How one shared list is used. */
export interface ListUsage {
  readonly modules: readonly {
    readonly moduleId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly field: string;
  }[];
  /** Content instances whose values reference the list (`caelo:list/<id>`). */
  readonly contentInstanceIds: readonly string[];
  /** Placements that render it (bound modules' placements + referencing instances' placements). */
  readonly placementCount: number;
  readonly samplePages: readonly {
    readonly pageId: string;
    readonly path: string;
    readonly title: string;
  }[];
  /** Page types that use the list as a vocabulary. */
  readonly pageTypes: readonly string[];
  /** Pages that carry at least one of its entries as a term. */
  readonly taggedPageCount: number;
}

/** True when anything still renders or references the list. */
export function isBound(u: ListUsage): boolean {
  return (
    u.modules.length > 0 ||
    u.contentInstanceIds.length > 0 ||
    u.pageTypes.length > 0 ||
    u.taggedPageCount > 0
  );
}

const SAMPLE_PAGES = 3;

/** Usage of each of `listIds`, keyed by list id. */
export async function loadListUsage(
  tx: TransactionRunner,
  branchId: string | null,
  listIds: readonly string[],
): Promise<Map<string, ListUsage>> {
  const out = new Map<string, ListUsage>();
  if (listIds.length === 0) return out;
  const refs = new Map(listIds.map((id) => [`caelo:list/${id}`, id]));

  const modulesByList = new Map<string, ListUsage["modules"][number][]>();
  for (const m of await loadModulesInView(tx, branchId, { referencing: listIds })) {
    for (const f of listFieldsOf(m.fields)) {
      for (const candidate of [f.list, f.default]) {
        const listId = typeof candidate === "string" ? refs.get(candidate) : undefined;
        if (!listId) continue;
        const arr = modulesByList.get(listId) ?? [];
        if (!arr.some((x) => x.moduleId === m.id && x.field === f.name)) {
          arr.push({ moduleId: m.id, slug: m.slug, displayName: m.displayName, field: f.name });
        }
        modulesByList.set(listId, arr);
      }
    }
  }

  const instancesByList = new Map<string, string[]>();
  // The index holds the list's id (it sits in `caelo:list/<id>`); the
  // reference form is confirmed on the parsed values below.
  for (const ci of await findContentInstancesContaining(tx, branchId, idNeedles(listIds))) {
    for (const [ref, listId] of refs) {
      if (!containsString(JSON.parse(ci.valuesText), ref)) continue;
      instancesByList.set(listId, [...(instancesByList.get(listId) ?? []), ci.contentInstanceId]);
    }
  }

  const pageTypes = await loadListEntities(tx, "pageType", branchId);

  // One statement per question for all lists, not one per list (#1269):
  // `lists.list` asks for every list of the site.
  const allInstanceIds = [...new Set([...instancesByList.values()].flat())];
  const allModuleIds = [...new Set([...modulesByList.values()].flat().map((m) => m.moduleId))];
  const ciCounts = await countPlacementsInView(tx, allInstanceIds, branchId);
  const modulePlacements = new Map<string, number>();
  if (allModuleIds.length > 0) {
    const rows = (await tx.execute(sql`
      SELECT module_id::text AS module_id, count(*)::int AS n FROM (
        SELECT pm.module_id FROM page_modules pm JOIN pages p ON p.id = pm.page_id
         WHERE pm.module_id = ANY(${uuidArray(allModuleIds)}) AND p.deleted_at IS NULL
        UNION ALL
        SELECT lm.module_id FROM layout_modules lm WHERE lm.module_id = ANY(${uuidArray(allModuleIds)})
      ) x GROUP BY module_id
    `)) as unknown as { module_id: string; n: number }[];
    for (const r of rows) modulePlacements.set(r.module_id, r.n);
  }
  const keys = listIds.flatMap((listId) => [
    ...(modulesByList.get(listId) ?? []).map((m) => ({ list_id: listId, module_id: m.moduleId })),
    ...(instancesByList.get(listId) ?? []).map((ci) => ({ list_id: listId, ci_id: ci })),
  ]);
  const samples = new Map<string, { pageId: string; path: string; title: string }[]>();
  if (keys.length > 0) {
    const rows = (await tx.execute(sql`
      SELECT list_id, page_id, path, title FROM (
        SELECT list_id, page_id, path, title,
               row_number() OVER (PARTITION BY list_id ORDER BY path) AS n
          FROM (
            SELECT DISTINCT k.list_id, p.id::text AS page_id, p.current_path AS path, p.title
              FROM jsonb_to_recordset((${JSON.stringify(keys)}::text)::jsonb) AS k(list_id text, module_id uuid, ci_id uuid)
              JOIN page_modules pm ON pm.module_id = k.module_id OR pm.content_instance_id = k.ci_id
              JOIN pages p ON p.id = pm.page_id
             WHERE p.deleted_at IS NULL
               AND (${branchId === null ? sql`p.chat_branch_id IS NULL` : sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`})
          ) d
      ) ranked WHERE n <= ${SAMPLE_PAGES}
      ORDER BY list_id, path
    `)) as unknown as { list_id: string; page_id: string; path: string; title: string }[];
    for (const r of rows) {
      samples.set(r.list_id, [
        ...(samples.get(r.list_id) ?? []),
        { pageId: r.page_id, path: r.path, title: r.title },
      ]);
    }
  }
  const tagged = await countPagesTaggedWithLists(tx, branchId, listIds);

  for (const listId of listIds) {
    const modules = modulesByList.get(listId) ?? [];
    const instanceIds = instancesByList.get(listId) ?? [];
    const placementCount =
      instanceIds.reduce((a, id) => a + (ciCounts.get(id) ?? 0), 0) +
      [...new Set(modules.map((m) => m.moduleId))].reduce(
        (a, id) => a + (modulePlacements.get(id) ?? 0),
        0,
      );
    out.set(listId, {
      modules,
      contentInstanceIds: instanceIds,
      placementCount,
      samplePages: samples.get(listId) ?? [],
      pageTypes: pageTypes
        .filter((pt) => pt.state.definition.vocabularies.some((v) => v.list === listId))
        .map((pt) => pt.state.slug),
      taggedPageCount: tagged.get(listId.toLowerCase()) ?? 0,
    });
  }
  return out;
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle;
  if (Array.isArray(value)) return value.some((v) => containsString(v, needle));
  if (value && typeof value === "object") {
    return Object.values(value).some((v) => containsString(v, needle));
  }
  return false;
}
