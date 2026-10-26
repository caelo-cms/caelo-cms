// SPDX-License-Identifier: MPL-2.0

/**
 * Editing helpers for list type and page type definitions (the Structure
 * and Types tabs, epic #1107 `docs/lists.md` §3, §5). Pure and immutable;
 * the components call these and show {@link listTypeIssues} live, so the
 * operator sees what the server would refuse before saving. The server
 * re-checks everything (`list_types.upsert_many`).
 */

import {
  checkListTypeDef,
  checkPageTypeDef,
  type FieldDef,
  type ListFieldType,
  type ListTypeDef,
  listTypeDefSchema,
  type NodeDef,
  type PageTypeDef,
  pageTypeDefSchema,
  type SourceDef,
} from "@caelo-cms/shared";

/** snake_case name from a label (`"Main link"` → `main_link`), never empty. */
export function snakeName(label: string, fallback = "field"): string {
  const s = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "")
    .slice(0, 64);
  return s === "" ? fallback : s;
}

/** `base`, else `base_2`, `base_3`, … — the first not in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`.slice(0, 64);
    if (!set.has(candidate)) return candidate;
  }
}

/** Context a new or retyped field needs (a term field names a vocabulary). */
export interface FieldContext {
  /** Slugs of vocabulary lists; a term field starts on the first one. */
  vocabularySlugs: readonly string[];
}

/**
 * The same field with another type: name, label, required and plugin
 * attributes are kept; attributes of the old type and the default (it
 * would not fit the new type) are dropped; the new type's required
 * attributes get a starting value.
 */
export function withFieldType(field: FieldDef, type: ListFieldType, ctx: FieldContext): FieldDef {
  const base = {
    name: field.name,
    label: field.label,
    ...(field.required ? { required: true } : {}),
    ...(field.ext ? { ext: field.ext } : {}),
  };
  switch (type) {
    case "select":
      return { ...base, type, options: field.type === "select" ? field.options : ["option_a"] };
    case "term":
      return {
        ...base,
        type,
        list: field.type === "term" ? field.list : (ctx.vocabularySlugs[0] ?? "tags"),
        ...(field.type === "term" && field.multiple ? { multiple: true } : {}),
      };
    default:
      return { ...base, type } as FieldDef;
  }
}

/** A new text field with a name not yet taken in `fields`. */
export function newField(fields: readonly FieldDef[], label = "New field"): FieldDef {
  return {
    name: uniqueName(
      snakeName(label),
      fields.map((f) => f.name),
    ),
    label,
    type: "text",
  };
}

/** A new node kind with one required text field, named after `label`. */
export function newNode(def: ListTypeDef, label: string): { kind: string; node: NodeDef } {
  const kind = uniqueName(snakeName(label, "entry"), Object.keys(def.nodes));
  return {
    kind,
    node: { label, fields: [{ name: "label", label: "Label", type: "text", required: true }] },
  };
}

function mapAllow(
  def: ListTypeDef,
  fn: (allow: readonly string[]) => string[],
): Pick<ListTypeDef, "root" | "nodes"> {
  const nodes: Record<string, NodeDef> = {};
  for (const [k, n] of Object.entries(def.nodes)) {
    nodes[k] = n.children ? { ...n, children: { ...n.children, allow: fn(n.children.allow) } } : n;
  }
  return { root: { ...def.root, allow: fn(def.root.allow) }, nodes };
}

/** Rename a node kind everywhere it is named (its key and every `allow`). */
export function renameNode(def: ListTypeDef, from: string, to: string): ListTypeDef {
  if (from === to || !def.nodes[from]) return def;
  const renamed = mapAllow(def, (allow) => allow.map((k) => (k === from ? to : k)));
  const nodes: Record<string, NodeDef> = {};
  for (const [k, n] of Object.entries(renamed.nodes)) nodes[k === from ? to : k] = n;
  return { ...def, root: renamed.root, nodes };
}

/** Remove a node kind and every `allow` entry naming it. */
export function removeNode(def: ListTypeDef, kind: string): ListTypeDef {
  const pruned = mapAllow(def, (allow) => allow.filter((k) => k !== kind));
  const { [kind]: _removed, ...nodes } = pruned.nodes;
  return { ...def, root: pruned.root, nodes };
}

/** Replace one node's definition. */
export function setNode(def: ListTypeDef, kind: string, node: NodeDef): ListTypeDef {
  return { ...def, nodes: { ...def.nodes, [kind]: node } };
}

/**
 * A node's content mode: stored children, a source (generated entries) or
 * neither. Switching drops what the other mode had — a node has either
 * children or a source (`checkListTypeDef`).
 */
export function withContentMode(
  node: NodeDef,
  mode: "none" | "children" | "query" | "system" | "plugin",
  kind: string,
): NodeDef {
  const { children: _c, source: _s, ...rest } = node;
  switch (mode) {
    case "none":
      return rest;
    case "children":
      return { ...rest, children: node.children ?? { name: "children", allow: [kind] } };
    case "query":
      return {
        ...rest,
        source:
          node.source?.kind === "query"
            ? node.source
            : {
                kind: "query",
                editable: ["limit"],
                defaults: { order: "published_desc", limit: 5 },
              },
      };
    case "system":
      return {
        ...rest,
        source: node.source?.kind === "system" ? node.source : { kind: "system", name: "children" },
      };
    case "plugin":
      return {
        ...rest,
        source: node.source?.kind === "plugin" ? node.source : { kind: "plugin", name: "source" },
      };
  }
}

/** The content mode of a node (see {@link withContentMode}). */
export function contentModeOf(node: NodeDef): "none" | "children" | "query" | "system" | "plugin" {
  if (node.children) return "children";
  return (node.source as SourceDef | undefined)?.kind ?? "none";
}

/** One problem found in a definition: where, and what to change. */
export interface DefIssue {
  path: string;
  message: string;
}

/** Everything `list_types.upsert_many` would refuse in `def` (shape + static rules). */
export function listTypeIssues(def: ListTypeDef): DefIssue[] {
  const parsed = listTypeDefSchema.safeParse(def);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    }));
  }
  return checkListTypeDef(parsed.data);
}

/** Everything `page_types.upsert_many` would refuse in `def` (shape + static rules). */
export function pageTypeIssues(def: PageTypeDef): DefIssue[] {
  const parsed = pageTypeDefSchema.safeParse(def);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    }));
  }
  return checkPageTypeDef(parsed.data);
}

/** Link fields of a node — the candidates for `current_from`. */
export function linkFieldNames(node: NodeDef): string[] {
  return node.fields.filter((f) => f.type === "link").map((f) => f.name);
}

/**
 * True when a server refusal of a type change asks for `dropValues`: the
 * change would delete stored values, and the operator must confirm it.
 */
export function needsDropValues(message: string): boolean {
  return /dropValues/.test(message);
}
