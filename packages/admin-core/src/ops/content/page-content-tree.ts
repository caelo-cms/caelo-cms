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

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import {
  loadBranchedModuleStates,
  loadContentInstanceBranchStates,
} from "../../snapshots/index.js";
import { listPlacementsInView } from "./content-instance-reach.js";
import { findContentInstancesContaining, idNeedles } from "./content-instance-refs.js";

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
  /**
   * Only this page renders it: nothing outside the page's tree lists it,
   * and no placement on another page binds it or any instance above it
   * (the placement's own instance included).
   */
  readonly exclusive: boolean;
}

/** Deepest nesting followed (the renderer's own bound is lower). */
const MAX_NESTING = 8;

/** The fields of a module row's `fields` column. */
export function placementFieldsOf(raw: unknown): PlacementField[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f): PlacementField[] => {
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
 * @param pageId the page the roots are placed on: `exclusive` says
 *   whether a nested instance renders on this page alone.
 * @param roots the page's placements: their key, bound content instance
 *   and its values (as the caller sees them).
 */
export async function loadNestedContent(
  tx: TransactionRunner,
  chatBranchId: string | null,
  pageId: string,
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
        WHERE id = ANY(${uuidArray(ids)}) AND deleted_at IS NULL
      `)) as unknown as { id: string; values: unknown }[];
      for (const r of rows) {
        valuesOf.set(r.id, (r.values ?? {}) as Record<string, unknown>);
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
    WHERE id = ANY(${uuidArray([...moduleIds])}) AND deleted_at IS NULL
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

  const exclusive = await exclusiveToPage(
    tx,
    chatBranchId,
    pageId,
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
 * The nested instances of `nestedIds` that only page `pageId` renders —
 * the ones a write bound to that page may change without changing
 * another page (#1309).
 *
 * Exclusivity is transitive. A nested instance whose parents all sit in
 * the page's tree is still shared when the placement above it is: a
 * placement bound to the same instance as the source page of a
 * translation (synced, or a variant whose nested references predate the
 * deep copy) renders every instance below it on both pages, at every
 * depth. So an instance of the tree is the page's own when
 *
 * - every placement binding it (as the caller's branch sees the site) is
 *   on `pageId`, and
 * - every instance listing it is in the page's tree and is itself the
 *   page's own. A parent outside the tree that renders nowhere today (a
 *   content-library instance) can be placed tomorrow, so it counts as
 *   sharing.
 *
 * Only the page's own tree is read (its instances' parents through the
 * reference index, their placements by instance id), never the whole
 * site: `list_for_page` runs once per translated page.
 */
async function exclusiveToPage(
  tx: TransactionRunner,
  chatBranchId: string | null,
  pageId: string,
  tree: ReadonlySet<string>,
  nestedIds: readonly string[],
): Promise<Set<string>> {
  const treeIds = [...tree];
  const placedElsewhere = new Set(
    (await listPlacementsInView(tx, treeIds, chatBranchId))
      .filter((p) => p.pageId !== pageId)
      .map((p) => p.contentInstanceId),
  );
  // Children of each tree instance, and the instances shared at the
  // source: placed on another page, or listed by an instance outside the
  // tree. Sharing then flows down to everything below them.
  const children = new Map<string, Set<string>>();
  const shared = new Set(placedElsewhere);
  for (const c of await findContentInstancesContaining(tx, chatBranchId, idNeedles(treeIds))) {
    const parsed = JSON.parse(c.valuesText) as Record<string, unknown>;
    for (const ref of nestedRefPaths(parsed)) {
      const child = ref.contentInstanceId;
      if (child === c.contentInstanceId || !tree.has(child)) continue;
      if (!tree.has(c.contentInstanceId)) {
        shared.add(child);
        continue;
      }
      const set = children.get(c.contentInstanceId) ?? new Set<string>();
      set.add(child);
      children.set(c.contentInstanceId, set);
    }
  }
  const stack = [...shared];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop() as string) ?? []) {
      if (shared.has(child)) continue;
      shared.add(child);
      stack.push(child);
    }
  }
  return new Set([...new Set(nestedIds)].filter((id) => !shared.has(id)));
}
