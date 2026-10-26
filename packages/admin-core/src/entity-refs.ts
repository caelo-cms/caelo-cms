// SPDX-License-Identifier: MPL-2.0

/**
 * References between branch state: which rows a snapshot state points at,
 * and whether such a row was created on a branch (exists only there until a
 * merge graduates it). Shared by the lock takeover (#620 Part C — adopted
 * changes take the rows they reference along) and the shared draft's Stage
 * closure (a Stage must ship the branch-created rows its changes reference).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { LockedEntityKind } from "./locks.js";

/** Live tables whose rows can be created on a chat branch (migrations 0089, 0093, 0350). */
export const BRANCH_CREATED_TABLE: Partial<Record<LockedEntityKind, string>> = {
  module: "modules",
  template: "templates",
  page: "pages",
  contentInstance: "content_instances",
  listType: "list_types",
  list: "lists",
  pageType: "page_types",
};

/**
 * Ids a snapshot state points at that may be rows created on a branch
 * (not yet merged). Only the shapes that carry references are inspected.
 */
export function referencedEntities(
  kind: LockedEntityKind,
  table: string,
  state: unknown,
): { kind: LockedEntityKind; id: string }[] {
  if (!state || typeof state !== "object") return [];
  const s = state as Record<string, unknown>;
  const out: { kind: LockedEntityKind; id: string }[] = [];
  if (table === "page_layout_snapshots" && Array.isArray(s.blocks)) {
    for (const block of s.blocks as Record<string, unknown>[]) {
      for (const id of Array.isArray(block.moduleIds) ? block.moduleIds : []) {
        if (typeof id === "string") out.push({ kind: "module", id });
      }
      for (const p of Array.isArray(block.placements) ? block.placements : []) {
        const placement = p as Record<string, unknown>;
        if (typeof placement.moduleId === "string") {
          out.push({ kind: "module", id: placement.moduleId });
        }
        if (typeof placement.contentInstanceId === "string") {
          out.push({ kind: "contentInstance", id: placement.contentInstanceId });
        }
      }
    }
  } else if (table === "layout_module_snapshots" && Array.isArray(s.moduleIds)) {
    for (const id of s.moduleIds) if (typeof id === "string") out.push({ kind: "module", id });
  } else if (table === "page_snapshots") {
    if (typeof s.templateId === "string") out.push({ kind: "template", id: s.templateId });
    // Epic #1107 — a page names its page type and the vocabulary lists of
    // its terms; any of them may be new in the branch.
    if (typeof s.pageTypeId === "string") out.push({ kind: "pageType", id: s.pageTypeId });
    for (const t of Array.isArray(s.terms) ? s.terms : []) {
      const m = typeof t === "string" ? TERM_LIST_RE.exec(t) : null;
      if (m?.[1]) out.push({ kind: "list", id: m[1] });
    }
  } else if (kind === "contentInstance") {
    if (typeof s.moduleId === "string") out.push({ kind: "module", id: s.moduleId });
    collectNestedRefs(s.values, out);
    collectListRefs(s.values, out);
  } else if (table === "page_module_content_snapshots") {
    collectNestedRefs(s.contentValues, out);
  } else if (table === "module_snapshots") {
    // A `list` field binding a shared list (`list: caelo:list/<id>`).
    collectListRefs(s.fields, out);
  } else if (table === "list_snapshots") {
    if (typeof s.listTypeId === "string") out.push({ kind: "listType", id: s.listTypeId });
    // Entries may embed modules (`module` fields) and other lists.
    collectNestedRefs(s.items, out);
    collectListRefs(s.items, out);
  } else if (table === "page_type_snapshots" && s.definition && typeof s.definition === "object") {
    const def = s.definition as { templates?: unknown; vocabularies?: unknown };
    for (const id of Array.isArray(def.templates) ? def.templates : []) {
      if (typeof id === "string") out.push({ kind: "template", id });
    }
    for (const v of Array.isArray(def.vocabularies) ? def.vocabularies : []) {
      const list = (v as { list?: unknown }).list;
      if (typeof list === "string") out.push({ kind: "list", id: list });
    }
  }
  return out;
}

const TERM_LIST_RE = /^caelo:term\/([0-9a-f-]{36})\//;
const LIST_REF_RE = /^caelo:list\/([0-9a-f-]{36})$/;

/** Every `caelo:list/<id>` string at any depth (bound shared lists). */
function collectListRefs(value: unknown, out: { kind: LockedEntityKind; id: string }[]): void {
  if (typeof value === "string") {
    const m = LIST_REF_RE.exec(value);
    if (m?.[1]) out.push({ kind: "list", id: m[1] });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectListRefs(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectListRefs(nested, out);
  }
}

/**
 * Nested module references inside content values: a `module` field holds
 * `{ moduleId, contentInstanceId }`, a `module-list` field an array of
 * them, at any depth. Each referenced module and content instance is a
 * dependency of the adopted content (the referenced instance's own values
 * are scanned in turn when it is adopted).
 */
function collectNestedRefs(value: unknown, out: { kind: LockedEntityKind; id: string }[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedRefs(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (typeof v.moduleId === "string") out.push({ kind: "module", id: v.moduleId });
  if (typeof v.contentInstanceId === "string") {
    out.push({ kind: "contentInstance", id: v.contentInstanceId });
  }
  for (const nested of Object.values(v)) collectNestedRefs(nested, out);
}

/** True iff the live row exists and was created on `branchId` (not yet merged). */
export async function createdOnBranch(
  tx: TransactionRunner,
  kind: LockedEntityKind,
  id: string,
  branchId: string,
): Promise<boolean> {
  const table = BRANCH_CREATED_TABLE[kind];
  if (!table) return false;
  const rows = (await tx.execute(sql`
    SELECT 1 FROM ${sql.raw(table)}
    WHERE id = ${id}::uuid AND chat_branch_id = ${branchId}::uuid
  `)) as unknown as unknown[];
  return rows.length > 0;
}
