// SPDX-License-Identifier: MPL-2.0

/**
 * What a page placement shows beyond its own stored values, for readers
 * that need ALL of a page's text — the international-site translator
 * above all (`page_module_content.list_for_page`):
 *
 * - the module's fields with their defaults. A field the placement has no
 *   value for renders its default, and the module extractor turns literal
 *   copy into exactly such defaults (button labels, form labels, menu
 *   entries). A reader that sees only stored values misses that text.
 * - the nested content: `module` / `module-list` values (also inside list
 *   entries) name other content instances, rendered inside the placement.
 *   Each comes with its own fields and values, the path it sits at, and
 *   whether it belongs to this page alone — writing to an instance that
 *   another page renders too would change that page.
 *
 * Everything is read as the caller sees it (branch overlays of modules
 * and content instances), like the placements themselves.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import {
  loadBranchedModuleStates,
  loadContentInstanceBranchStates,
} from "../../snapshots/index.js";
import { findContentInstancesContaining } from "./content-instance-refs.js";

/** A module field as readers of the page's text need it. */
export interface PlacementField {
  readonly name: string;
  readonly kind: string;
  readonly default?: unknown;
  /** `list` fields: the list type and binding. */
  readonly listType?: string;
  readonly bind?: string;
}

/** One nested content instance inside a placement. */
export interface NestedContent {
  /**
   * Where it sits, from the placement: `cards[2]` (a module-list entry),
   * `hero` (a module field), `items[<entryId>].card` (inside a list
   * entry); nested deeper levels are joined with `>`.
   */
  readonly path: string;
  readonly contentInstanceId: string;
  readonly moduleSlug: string;
  readonly fields: readonly PlacementField[];
  readonly values: Readonly<Record<string, unknown>>;
  /** Only this page renders it (no other placement, no parent elsewhere). */
  readonly exclusive: boolean;
}

/** Deepest nesting followed (the renderer's own bound is lower). */
const MAX_NESTING = 8;

/** The fields of a module row's `fields` column. */
export function placementFieldsOf(raw: unknown): PlacementField[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((f): PlacementField[] => {
    const o = f as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.kind !== "string") return [];
    return [
      {
        name: o.name,
        kind: o.kind,
        ...(o.default !== undefined ? { default: o.default } : {}),
        ...(typeof o.listType === "string" ? { listType: o.listType } : {}),
        ...(typeof o.bind === "string" ? { bind: o.bind } : {}),
      },
    ];
  });
}

interface Ref {
  readonly path: string;
  readonly moduleId: string;
  readonly contentInstanceId: string;
}

function isRef(v: unknown): v is { moduleId: string; contentInstanceId: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { moduleId?: unknown }).moduleId === "string" &&
    typeof (v as { contentInstanceId?: unknown }).contentInstanceId === "string"
  );
}

/**
 * Every nested reference in `values` with its path: direct `module` /
 * `module-list` values, and the ones inside local list entries
 * (`{ id, values, children }`) at any depth.
 */
export function nestedRefPaths(values: Readonly<Record<string, unknown>>): Ref[] {
  const out: Ref[] = [];
  const visitValue = (v: unknown, path: string) => {
    if (isRef(v)) {
      out.push({ path, moduleId: v.moduleId, contentInstanceId: v.contentInstanceId });
      return;
    }
    if (!Array.isArray(v)) return;
    v.forEach((el, i) => {
      if (isRef(el)) {
        out.push({
          path: `${path}[${i}]`,
          moduleId: el.moduleId,
          contentInstanceId: el.contentInstanceId,
        });
        return;
      }
      visitEntry(el, path);
    });
  };
  const visitEntry = (entry: unknown, field: string) => {
    const e = entry as { id?: unknown; values?: unknown; children?: unknown } | null;
    if (!e || typeof e.id !== "string") return;
    if (typeof e.values === "object" && e.values !== null) {
      for (const [k, inner] of Object.entries(e.values as Record<string, unknown>)) {
        visitValue(inner, `${field}[${e.id}].${k}`);
      }
    }
    if (Array.isArray(e.children)) for (const c of e.children) visitEntry(c, field);
  };
  for (const [field, v] of Object.entries(values)) visitValue(v, field);
  return out;
}

/**
 * The nested content of each root placement, keyed like `roots`.
 *
 * @param roots the page's placements: their key, bound content instance
 *   and its values (as the caller sees them).
 */
export async function loadNestedContent(
  tx: TransactionRunner,
  chatBranchId: string | null,
  roots: readonly {
    readonly key: string;
    readonly contentInstanceId: string;
    readonly values: Readonly<Record<string, unknown>>;
  }[],
): Promise<Map<string, NestedContent[]>> {
  const out = new Map<string, NestedContent[]>(roots.map((r) => [r.key, []]));
  type Pending = Ref & { readonly root: string; readonly depth: number };
  let frontier: Pending[] = roots.flatMap((r) =>
    nestedRefPaths(r.values).map((ref) => ({ ...ref, root: r.key, depth: 1 })),
  );
  const found: (Pending & { values: Record<string, unknown> })[] = [];
  const valuesOf = new Map<string, Record<string, unknown>>();
  const moduleIds = new Set<string>();
  while (frontier.length > 0) {
    const ids = [...new Set(frontier.map((f) => f.contentInstanceId))].filter(
      (id) => !valuesOf.has(id),
    );
    if (ids.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, "values" FROM content_instances
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND deleted_at IS NULL
      `)) as unknown as { id: string; values: unknown }[];
      for (const r of rows) {
        valuesOf.set(
          r.id,
          ((typeof r.values === "string" ? JSON.parse(r.values) : r.values) ?? {}) as Record<
            string,
            unknown
          >,
        );
      }
      if (chatBranchId) {
        for (const [id, state] of await loadContentInstanceBranchStates(tx, ids, chatBranchId)) {
          if (state.deletedAt) valuesOf.delete(id);
          else valuesOf.set(id, state.values as Record<string, unknown>);
        }
      }
    }
    const next: Pending[] = [];
    for (const f of frontier) {
      const values = valuesOf.get(f.contentInstanceId);
      // A dangling reference renders nothing (the references check
      // reports it); there is no text to read.
      if (values === undefined) continue;
      found.push({ ...f, values });
      moduleIds.add(f.moduleId);
      if (f.depth < MAX_NESTING) {
        for (const ref of nestedRefPaths(values)) {
          next.push({ ...ref, path: `${f.path}>${ref.path}`, root: f.root, depth: f.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  if (found.length === 0) return out;

  const modules = new Map<string, { slug: string; fields: PlacementField[] }>();
  const moduleRows = (await tx.execute(sql`
    SELECT id::text AS id, slug, fields FROM modules
    WHERE id IN (${sql.join(
      [...moduleIds].map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND deleted_at IS NULL
  `)) as unknown as { id: string; slug: string; fields: unknown }[];
  for (const m of moduleRows) {
    modules.set(m.id, { slug: m.slug, fields: placementFieldsOf(m.fields) });
  }
  if (chatBranchId) {
    for (const [id, state] of await loadBranchedModuleStates(tx, chatBranchId, [...moduleIds])) {
      if (state.deletedAt) modules.delete(id);
      else modules.set(id, { slug: state.slug, fields: placementFieldsOf(state.fields) });
    }
  }

  const exclusive = await exclusiveToTree(
    tx,
    chatBranchId,
    new Set([...roots.map((r) => r.contentInstanceId), ...found.map((f) => f.contentInstanceId)]),
    found.map((f) => f.contentInstanceId),
  );
  for (const f of found) {
    const m = modules.get(f.moduleId);
    if (!m) continue;
    out.get(f.root)?.push({
      path: f.path,
      contentInstanceId: f.contentInstanceId,
      moduleSlug: m.slug,
      fields: m.fields,
      values: f.values,
      exclusive: exclusive.has(f.contentInstanceId),
    });
  }
  return out;
}

/**
 * The nested instances of `nestedIds` that only this page's tree renders:
 * no placement binds them directly, and every instance referencing them
 * is itself in `tree`.
 */
async function exclusiveToTree(
  tx: TransactionRunner,
  chatBranchId: string | null,
  tree: ReadonlySet<string>,
  nestedIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(nestedIds)];
  const bound = (await tx.execute(sql`
    SELECT DISTINCT content_instance_id::text AS id FROM page_modules
    WHERE content_instance_id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string }[];
  const placed = new Set(bound.map((b) => b.id));
  const parents = new Map<string, Set<string>>();
  for (const c of await findContentInstancesContaining(tx, chatBranchId, ids)) {
    const parsed = JSON.parse(c.valuesText) as Record<string, unknown>;
    for (const ref of nestedRefPaths(parsed)) {
      if (ref.contentInstanceId === c.contentInstanceId) continue;
      const set = parents.get(ref.contentInstanceId) ?? new Set<string>();
      set.add(c.contentInstanceId);
      parents.set(ref.contentInstanceId, set);
    }
  }
  const out = new Set<string>();
  for (const id of ids) {
    if (placed.has(id)) continue;
    if ([...(parents.get(id) ?? [])].every((p) => tree.has(p))) out.add(id);
  }
  return out;
}
