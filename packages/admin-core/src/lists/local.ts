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

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ListPaginationSettings, SourceDef } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../draft.js";
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
 * Every non-deleted module the caller sees, with its fields as the branch
 * has them.
 */
export async function loadModulesInView(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<ModuleInView[]> {
  const visible = branchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, slug, display_name, fields, deleted_at
    FROM modules WHERE ${visible}
    ORDER BY slug
  `)) as unknown as {
    id: string;
    slug: string;
    display_name: string;
    fields: unknown;
    deleted_at: string | Date | null;
  }[];
  const branched = branchId ? await loadBranchedModuleStates(tx, branchId) : new Map();
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
    WHERE ${visible} AND module_id IN (${sql.join(
      moduleIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
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

/** The page terms in the caller's view that use vocabulary `listId`: page id → term refs. */
export async function pageTermsOfList(
  tx: TransactionRunner,
  branchId: string | null,
  listId: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const prefix = `caelo:term/${listId}/`;
  const live = (await tx.execute(sql`
    SELECT pt.page_id::text AS page_id,
           'caelo:term/' || pt.list_id::text || '/' || pt.item_id::text AS ref
    FROM page_terms pt JOIN pages p ON p.id = pt.page_id
    WHERE pt.list_id = ${listId}::uuid AND p.deleted_at IS NULL
      AND ${branchId ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)` : sql`p.chat_branch_id IS NULL`}
  `)) as unknown as { page_id: string; ref: string }[];
  for (const r of live) out.set(r.page_id, [...(out.get(r.page_id) ?? []), r.ref]);
  if (!branchId) return out;
  const branched = (await tx.execute(sql`
    SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
      FROM page_snapshots ps JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
     WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
     ORDER BY ps.page_id, ss.created_at DESC
  `)) as unknown as { page_id: string; state: unknown }[];
  for (const b of branched) {
    const state = b.state as {
      terms?: unknown;
      deletedAt?: string | null;
    };
    const terms = Array.isArray(state.terms)
      ? state.terms.filter((t): t is string => typeof t === "string" && t.startsWith(prefix))
      : [];
    if (state.deletedAt || terms.length === 0) out.delete(b.page_id);
    else out.set(b.page_id, terms);
  }
  return out;
}
