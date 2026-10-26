// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — where a shared list is used, as the caller sees the site
 * (docs/lists.md §12 `lists.list` usage; CLAUDE.md §1A decision support):
 * the modules whose `list` field binds it, the placements whose value
 * points at it, a few pages that show it, the page types that use it as a
 * vocabulary and how many pages carry its terms. The same reading backs
 * the "refused while bound" rule of `lists.delete_many`.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { findContentInstancesContaining } from "../ops/content/content-instance-refs.js";
import { countPlacementsInView } from "../ops/content/content-instances.js";
import { listFieldsOf, loadModulesInView, pageTermsOfList } from "./local.js";
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
  for (const m of await loadModulesInView(tx, branchId)) {
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
  for (const ci of await findContentInstancesContaining(tx, branchId, [...refs.keys()])) {
    for (const [ref, listId] of refs) {
      if (!containsString(JSON.parse(ci.valuesText), ref)) continue;
      instancesByList.set(listId, [...(instancesByList.get(listId) ?? []), ci.contentInstanceId]);
    }
  }

  const pageTypes = await loadListEntities(tx, "pageType", branchId);

  for (const listId of listIds) {
    const modules = modulesByList.get(listId) ?? [];
    const instanceIds = instancesByList.get(listId) ?? [];
    const moduleIds = modules.map((m) => m.moduleId);
    const ciCounts = await countPlacementsInView(tx, instanceIds, branchId);
    let placementCount = [...ciCounts.values()].reduce((a, b) => a + b, 0);
    const moduleIdList =
      moduleIds.length === 0
        ? sql`NULL::uuid`
        : sql.join(
            moduleIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          );
    const instanceIdList =
      instanceIds.length === 0
        ? sql`NULL::uuid`
        : sql.join(
            instanceIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          );
    if (moduleIds.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM page_modules pm JOIN pages p ON p.id = pm.page_id
            WHERE pm.module_id IN (${moduleIdList}) AND p.deleted_at IS NULL) +
          (SELECT count(*)::int FROM layout_modules lm WHERE lm.module_id IN (${moduleIdList})) AS n
      `)) as unknown as { n: number }[];
      placementCount += rows[0]?.n ?? 0;
    }
    const samplePages =
      moduleIds.length + instanceIds.length === 0
        ? []
        : ((await tx.execute(sql`
            SELECT DISTINCT p.id::text AS page_id, p.current_path AS path, p.title
            FROM page_modules pm JOIN pages p ON p.id = pm.page_id
            WHERE p.deleted_at IS NULL
              AND (${branchId === null ? sql`p.chat_branch_id IS NULL` : sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`})
              AND (pm.module_id IN (${moduleIdList}) OR pm.content_instance_id IN (${instanceIdList}))
            ORDER BY p.current_path
            LIMIT ${SAMPLE_PAGES}
          `)) as unknown as { page_id: string; path: string; title: string }[]);
    const vocabularyOf = pageTypes
      .filter((pt) => pt.state.definition.vocabularies.some((v) => v.list === listId))
      .map((pt) => pt.state.slug);
    const tagged = await pageTermsOfList(tx, branchId, listId);
    out.set(listId, {
      modules,
      contentInstanceIds: instanceIds,
      placementCount,
      samplePages: samplePages.map((p) => ({ pageId: p.page_id, path: p.path, title: p.title })),
      pageTypes: vocabularyOf,
      taggedPageCount: tagged.size,
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
