// SPDX-License-Identifier: MPL-2.0

/**
 * List types — the definition part of a list (epic #1107,
 * `docs/lists.md` §3). A list type names the entry kinds (`nodes`), the
 * fields each carries, what may hang under what, and which nodes are
 * filled from a source instead of stored children. Every form of list
 * is expressed with it: a flat link group, a three-level menu, a mega
 * dropdown with columns, teasers and a "latest news" block, an unbounded
 * category tree.
 */

import { z } from "zod";
import {
  checkFieldDef,
  type FieldDef,
  fieldDefSchema,
  fieldExtSchema,
  isReservedListName,
  type ListIssue,
  listNameSchema,
} from "./fields.js";

/** Hard ceiling for any tree, recursive or not. */
export const LIST_MAX_DEPTH = 8;
/** Entries per list (all levels together). */
export const LIST_MAX_ITEMS = 500;
/** Entries one query may return. */
export const LIST_QUERY_MAX_LIMIT = 50;

export const QUERY_KNOBS = [
  "page_type",
  "terms",
  "terms_mode",
  "parent",
  "exclude_current",
  "order",
  "limit",
] as const;
export type QueryKnob = (typeof QUERY_KNOBS)[number];

export const SYSTEM_SOURCE_NAMES = [
  "breadcrumbs",
  "children",
  "siblings",
  "page_terms",
  "term_pages",
] as const;
export type SystemSourceName = (typeof SYSTEM_SOURCE_NAMES)[number];

const queryOrderSchema = z.union([
  z.enum(["published_desc", "published_asc", "title_asc"]),
  z.string().regex(/^prop_(?:desc|asc):[a-z][a-z0-9_]{0,63}$/),
]);

/** A query over pages. Resolved at render time; nothing is stored. */
export const pageQuerySchema = z
  .object({
    page_type: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    terms: z
      .array(z.string().regex(/^caelo:term\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/))
      .max(20)
      .optional(),
    terms_mode: z.enum(["any", "all"]).optional(),
    parent: z
      .string()
      .regex(/^caelo:page\/[0-9a-f-]{36}$/)
      .optional(),
    exclude_current: z.boolean().optional(),
    order: queryOrderSchema,
    limit: z.number().int().min(1).max(LIST_QUERY_MAX_LIMIT),
  })
  .strict();
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** Partial query: defaults on a node, or the knobs an entry overrides. */
export const pageQueryPartialSchema = pageQuerySchema.partial();

export const sourceDefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("query"),
      /** Which query parts an editor (or the AI) may set per entry/placement. */
      editable: z.array(z.enum(QUERY_KNOBS)).max(QUERY_KNOBS.length),
      defaults: pageQueryPartialSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), name: z.enum(SYSTEM_SOURCE_NAMES) }).strict(),
  z
    .object({
      kind: z.literal("plugin"),
      /** The list-source name an active plugin declared. */
      name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    })
    .strict(),
]);
export type SourceDef = z.infer<typeof sourceDefSchema>;

const childrenSchema = z
  .object({
    /** Loop name in templates (`{{#columns}}`). Storage always uses `children`. */
    name: listNameSchema,
    allow: z.array(listNameSchema).min(1).max(32),
    max: z.number().int().min(1).max(LIST_MAX_ITEMS).optional(),
  })
  .strict();

export const nodeDefSchema = z
  .object({
    label: z.string().min(1).max(128),
    fields: z.array(fieldDefSchema).max(32),
    children: childrenSchema.optional(),
    /** Link field that decides `is_current` / `is_ancestor`. */
    current_from: listNameSchema.optional(),
    /** Generated children (`items`) instead of stored ones. */
    source: sourceDefSchema.optional(),
    ext: fieldExtSchema.optional(),
  })
  .strict();
export type NodeDef = z.infer<typeof nodeDefSchema>;

export const LIST_TYPE_ROLES = ["navigation", "vocabulary", "content"] as const;
export type ListTypeRole = (typeof LIST_TYPE_ROLES)[number];

export const listTypeDefSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    name: z.string().min(1).max(200),
    purpose: z.string().min(1).max(1000),
    role: z.enum(LIST_TYPE_ROLES),
    root: z
      .object({
        allow: z.array(listNameSchema).min(1).max(32),
        max: z.number().int().min(1).max(LIST_MAX_ITEMS).optional(),
      })
      .strict(),
    nodes: z.record(listNameSchema, nodeDefSchema),
    max_depth: z.number().int().min(1).max(LIST_MAX_DEPTH).optional(),
  })
  .strict();
export type ListTypeDef = z.infer<typeof listTypeDefSchema>;

/**
 * Static checks Zod cannot express. Returns every issue found so the AI
 * fixes a definition in one round instead of one error per call.
 */
export function checkListTypeDef(def: ListTypeDef): ListIssue[] {
  const issues: ListIssue[] = [];
  const kinds = new Set(Object.keys(def.nodes));
  if (kinds.size === 0) {
    issues.push({ path: "nodes", message: "a list type needs at least one node kind." });
  }
  const checkAllow = (allow: readonly string[], path: string): void => {
    for (const k of allow) {
      if (!kinds.has(k)) {
        issues.push({
          path,
          message: `node kind "${k}" is not defined — add it under nodes or remove it from allow.`,
        });
      }
    }
  };
  checkAllow(def.root.allow, "root.allow");

  for (const [kind, node] of Object.entries(def.nodes)) {
    const at = `nodes.${kind}`;
    if (isReservedListName(kind)) {
      issues.push({ path: at, message: `node kind "${kind}" is a reserved name — rename it.` });
    }
    const seen = new Set<string>();
    node.fields.forEach((f, i) => {
      const fp = `${at}.fields[${i}]`;
      if (seen.has(f.name)) issues.push({ path: fp, message: `duplicate field name "${f.name}".` });
      seen.add(f.name);
      issues.push(...checkFieldDef(f, fp));
    });
    if (node.children) {
      if (isReservedListName(node.children.name)) {
        issues.push({
          path: `${at}.children.name`,
          message: `children name "${node.children.name}" is reserved — pick another loop name.`,
        });
      }
      if (seen.has(node.children.name)) {
        issues.push({
          path: `${at}.children.name`,
          message: `children name "${node.children.name}" collides with a field of the same node.`,
        });
      }
      checkAllow(node.children.allow, `${at}.children.allow`);
    }
    if (node.children && node.source) {
      issues.push({
        path: at,
        message: "a node has either stored children or a source, not both — remove one.",
      });
    }
    if (node.current_from !== undefined) {
      const target = node.fields.find((f) => f.name === node.current_from);
      if (target?.type !== "link") {
        issues.push({
          path: `${at}.current_from`,
          message: `current_from must name a link field of this node ("${node.current_from}" is not one).`,
        });
      }
    }
    if (node.source?.kind === "query") {
      const q = pageQueryPartialSchema.safeParse(node.source.defaults);
      if (!q.success) {
        issues.push({ path: `${at}.source.defaults`, message: "query defaults are invalid." });
      } else if (
        node.source.defaults.order === undefined &&
        !node.source.editable.includes("order")
      ) {
        issues.push({
          path: `${at}.source`,
          message: 'a query source needs a default "order" or "order" in editable.',
        });
      } else if (
        node.source.defaults.limit === undefined &&
        !node.source.editable.includes("limit")
      ) {
        issues.push({
          path: `${at}.source`,
          message: 'a query source needs a default "limit" or "limit" in editable.',
        });
      }
    }
  }

  if (hasRecursion(def) && def.max_depth === undefined) {
    issues.push({
      path: "max_depth",
      message: "this type nests a node kind inside itself — set max_depth (1–8).",
    });
  }

  if (def.role === "vocabulary") {
    const rootKinds = def.root.allow;
    for (const k of rootKinds) {
      const node = def.nodes[k];
      if (!node) continue;
      const hasText = (n: string): boolean =>
        node.fields.some((f: FieldDef) => f.name === n && f.type === "text");
      if (!hasText("name") || !hasText("slug")) {
        issues.push({
          path: `nodes.${k}`,
          message: 'vocabulary entries need a text field "name" and a text field "slug".',
        });
      }
      if (node.source) {
        issues.push({ path: `nodes.${k}`, message: "vocabulary entries cannot have a source." });
      }
    }
  }
  return issues;
}

/** True when some node kind can (transitively) contain itself. */
export function hasRecursion(def: ListTypeDef): boolean {
  const edges = new Map<string, readonly string[]>();
  for (const [k, n] of Object.entries(def.nodes)) edges.set(k, n.children?.allow ?? []);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (k: string): boolean => {
    if (visiting.has(k)) return true;
    if (done.has(k)) return false;
    visiting.add(k);
    for (const c of edges.get(k) ?? []) if (visit(c)) return true;
    visiting.delete(k);
    done.add(k);
    return false;
  };
  return [...edges.keys()].some(visit);
}

/**
 * Effective depth limit of a type: `max_depth` when set, else the
 * longest non-recursive path (bounded by {@link LIST_MAX_DEPTH}).
 */
export function effectiveMaxDepth(def: ListTypeDef): number {
  if (def.max_depth !== undefined) return def.max_depth;
  const longest = (k: string, seen: ReadonlySet<string>): number => {
    if (seen.has(k)) return LIST_MAX_DEPTH;
    const next = new Set(seen).add(k);
    const kids = def.nodes[k]?.children?.allow ?? [];
    return 1 + kids.reduce((m, c) => Math.max(m, longest(c, next)), 0);
  };
  return Math.min(
    LIST_MAX_DEPTH,
    def.root.allow.reduce((m, k) => Math.max(m, longest(k, new Set())), 0),
  );
}
