// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — `list` module fields and the LOCAL lists they hold
 * (docs/lists.md §7), as the caller sees them.
 *
 * A local list is not an entity: it is the default of a module field or a
 * content instance's value for that field. Changing a list type must still
 * keep every one of them valid (§3 "Changing a type that has lists"), and a
 * shared list's usage is read from the same fields (who binds
 * `caelo:list/<id>`). Both questions need the modules and content instances
 * in the caller's branch view: live rows superseded by the branch's newest
 * pending snapshots — the same overlay every module / instance read uses.
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import type { ListPaginationSettings, SourceDef } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { headOverlaySql, pendingRefCandidatesSql } from "../draft.js";
import { loadBranchedModuleStates, loadContentInstanceBranchStates } from "../snapshots/index.js";

/** A module field of kind `list` (shape owned by the module field schema, docs §7). */
export interface ListFieldDef {
  readonly name: string;
  readonly label: string;
  readonly kind: "list";
  readonly listType: string;
  readonly bind?: "local" | "shared" | "source";
  readonly list?: string;
  readonly source?: SourceDef;
  /** #1257 — the field lists every match across follow-up pages. */
  readonly paginate?: ListPaginationSettings;
  readonly min?: number;
  readonly max?: number;
  readonly default?: unknown;
}

/** One module in the caller's view. */
export interface ModuleInView {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly fields: readonly unknown[];
}

/** One content instance in the caller's view. */
export interface InstanceInView {
  readonly id: string;
  readonly moduleId: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** `caelo:list/<id>` */
export const LIST_REF_RE = /^caelo:list\/([0-9a-f-]{36})$/;

/** The list id of a `caelo:list/<id>` reference, or null. */
export function parseListRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return LIST_REF_RE.exec(value)?.[1] ?? null;
}

/** The `list` fields of a module field array (anything else is skipped). */
export function listFieldsOf(fields: readonly unknown[]): ListFieldDef[] {
  return fields.filter(
    (f): f is ListFieldDef =>
      typeof f === "object" &&
      f !== null &&
      (f as { kind?: unknown }).kind === "list" &&
      typeof (f as { name?: unknown }).name === "string" &&
      typeof (f as { listType?: unknown }).listType === "string",
  );
}

/** The binding of a list field (`local` when unset, docs §7). */
export function bindingOf(field: ListFieldDef): "local" | "shared" | "source" {
  return field.bind ?? "local";
}

/**
 * The non-deleted modules the caller sees, with their fields as the branch
 * has them — every module, or only `ids`, or only the modules whose fields
 * may reference one of `referencing` (the module reference tables, 0595;
 * the caller confirms on the returned fields). The scoped forms read the
 * matches, never every module and pending module (#1391).
 */
export async function loadModulesInView(
  tx: TransactionRunner,
  branchId: string | null,
  scope: { readonly ids?: readonly string[]; readonly referencing?: readonly string[] } = {},
): Promise<ModuleInView[]> {
  const visible = branchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  let ids = scope.ids;
  if (scope.referencing !== undefined) {
    const needles = [...new Set(scope.referencing.map((id) => id.toLowerCase()))];
    if (needles.length === 0) return [];
    const found = (await tx.execute(sql`
      SELECT DISTINCT module_id::text AS id FROM module_refs
       WHERE ref_kind = 'id' AND ref = ANY(${textArray(needles)})
      ${branchId ? sql`UNION ${pendingRefCandidatesSql({ kind: "module", branchId, ids: needles })}` : sql``}
    `)) as unknown as { id?: string; entity_id?: string }[];
    ids = [...new Set(found.map((r) => r.id ?? r.entity_id ?? ""))].filter((id) => id !== "");
  }
  if (ids !== undefined && ids.length === 0) return [];
  const idFilter = ids ? sql` AND id = ANY(${uuidArray(ids)})` : sql``;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, slug, display_name, fields, deleted_at
    FROM modules WHERE ${visible}${idFilter}
    ORDER BY slug
  `)) as unknown as {
    id: string;
    slug: string;
    display_name: string;
    fields: unknown;
    deleted_at: string | Date | null;
  }[];
  const branched = branchId
    ? await loadBranchedModuleStates(tx, branchId, ids ?? undefined)
    : new Map();
  const out: ModuleInView[] = [];
  for (const r of rows) {
    const b = branched.get(r.id);
    const deleted = b ? b.deletedAt !== null : r.deleted_at !== null;
    if (deleted) continue;
    const rawFields = b ? b.fields : r.fields;
    out.push({
      id: r.id,
      slug: b ? b.slug : r.slug,
      displayName: b ? b.displayName : r.display_name,
      fields: Array.isArray(rawFields) ? rawFields : [],
    });
  }
  return out;
}

/** Non-deleted content instances of `moduleIds` as the caller sees them. */
export async function loadInstancesOfModules(
  tx: TransactionRunner,
  branchId: string | null,
  moduleIds: readonly string[],
): Promise<InstanceInView[]> {
  if (moduleIds.length === 0) return [];
  const visible = branchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, module_id::text AS module_id, "values", deleted_at
    FROM content_instances
    WHERE ${visible} AND module_id = ANY(${uuidArray(moduleIds)})
    ORDER BY created_at, id
  `)) as unknown as {
    id: string;
    module_id: string;
    values: unknown;
    deleted_at: string | Date | null;
  }[];
  const branched = branchId
    ? await loadContentInstanceBranchStates(
        tx,
        rows.map((r) => r.id),
        branchId,
      )
    : new Map();
  const out: InstanceInView[] = [];
  for (const r of rows) {
    const b = branched.get(r.id);
    const deleted = b ? b.deletedAt !== null : r.deleted_at !== null;
    if (deleted) continue;
    const values = b ? b.values : r.values;
    out.push({
      id: r.id,
      moduleId: r.module_id,
      values: (values ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

/** Where a local list lives. */
export type LocalListPlace =
  | {
      readonly kind: "moduleDefault";
      readonly moduleId: string;
      readonly moduleSlug: string;
      readonly field: string;
    }
  | {
      readonly kind: "instance";
      readonly contentInstanceId: string;
      readonly moduleId: string;
      readonly moduleSlug: string;
      readonly field: string;
    };

/** One local list of a list type. */
export interface LocalList {
  readonly place: LocalListPlace;
  readonly items: unknown;
}

/** Human description of a local list's place, for messages to the AI. */
export function describeLocalPlace(place: LocalListPlace): string {
  return place.kind === "moduleDefault"
    ? `the default of field "${place.field}" of module "${place.moduleSlug}"`
    : `field "${place.field}" of content instance ${place.contentInstanceId} (module "${place.moduleSlug}")`;
}

/**
 * Every local list of list type `listTypeSlug` the caller sees: defaults of
 * local `list` fields, and the values content instances hold for them.
 */
export async function findLocalLists(
  tx: TransactionRunner,
  branchId: string | null,
  listTypeSlug: string,
): Promise<LocalList[]> {
  const modules = await loadModulesInView(tx, branchId);
  const out: LocalList[] = [];
  const fieldsByModule = new Map<string, { slug: string; fields: ListFieldDef[] }>();
  for (const m of modules) {
    const fields = listFieldsOf(m.fields).filter(
      (f) => f.listType === listTypeSlug && bindingOf(f) === "local",
    );
    if (fields.length === 0) continue;
    fieldsByModule.set(m.id, { slug: m.slug, fields });
    for (const f of fields) {
      if (Array.isArray(f.default)) {
        out.push({
          place: { kind: "moduleDefault", moduleId: m.id, moduleSlug: m.slug, field: f.name },
          items: f.default,
        });
      }
    }
  }
  for (const ci of await loadInstancesOfModules(tx, branchId, [...fieldsByModule.keys()])) {
    const owner = fieldsByModule.get(ci.moduleId);
    if (!owner) continue;
    for (const f of owner.fields) {
      const v = ci.values[f.name];
      if (!Array.isArray(v)) continue;
      out.push({
        place: {
          kind: "instance",
          contentInstanceId: ci.id,
          moduleId: ci.moduleId,
          moduleSlug: owner.slug,
          field: f.name,
        },
        items: v,
      });
    }
  }
  return out;
}

/**
 * How many pages in the caller's view carry a term of each vocabulary in
 * `listIds`, keyed by list id (0 when none).
 *
 * The cost is the tagged pages and the matching pending ones, never the
 * draft (#1269): on a branch, the pending pages that matter are the
 * tagged live pages a chat changed (their newest state may have dropped
 * the term) and the pending pages whose terms reference one of the lists
 * (the page snapshot reference table, 0594). Each of those is judged on
 * its newest state; every other tagged page counts as stored.
 */
export async function countPagesTaggedWithLists(
  tx: TransactionRunner,
  branchId: string | null,
  listIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(listIds.map((id) => id.toLowerCase()))];
  const out = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return out;
  const visibility = branchId
    ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`
    : sql`p.chat_branch_id IS NULL`;
  let pendingIds: string[] = [];
  if (branchId) {
    const candidates = (await tx.execute(sql`
      SELECT DISTINCT d.entity_id::text AS entity_id
        FROM page_terms pt
        JOIN draft_pending_entities d
          ON d.entity_id = pt.page_id AND d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'page'
       WHERE pt.list_id = ANY(${uuidArray(ids)})
      UNION
      ${pendingRefCandidatesSql({ kind: "page", branchId, ids })}
    `)) as unknown as { entity_id: string }[];
    pendingIds = candidates.map((c) => c.entity_id);
    if (pendingIds.length > 0) {
      const heads = (await tx.execute(
        headOverlaySql({
          kind: "page",
          table: "page_snapshots",
          branchId,
          ids: pendingIds,
          columns: sql`jsonb_build_object('terms', es.state->'terms', 'deletedAt', es.state->'deletedAt') AS state`,
        }),
      )) as unknown as {
        entity_id: string;
        state: { terms?: unknown; deletedAt?: string | null };
      }[];
      for (const h of heads) {
        if (h.state.deletedAt || !Array.isArray(h.state.terms)) continue;
        const tagged = new Set<string>();
        for (const t of h.state.terms) {
          if (typeof t !== "string") continue;
          const listId = /^caelo:term\/([^/]+)\//.exec(t.toLowerCase())?.[1];
          if (listId !== undefined && out.has(listId)) tagged.add(listId);
        }
        for (const listId of tagged) out.set(listId, (out.get(listId) ?? 0) + 1);
      }
    }
  }
  const live = (await tx.execute(sql`
    SELECT pt.list_id::text AS list_id, count(DISTINCT pt.page_id)::int AS n
      FROM page_terms pt JOIN pages p ON p.id = pt.page_id
     WHERE pt.list_id = ANY(${uuidArray(ids)}) AND p.deleted_at IS NULL AND ${visibility}
       AND pt.page_id <> ALL(${uuidArray(pendingIds)})
     GROUP BY pt.list_id
  `)) as unknown as { list_id: string; n: number }[];
  for (const r of live) out.set(r.list_id, (out.get(r.list_id) ?? 0) + r.n);
  return out;
}
