// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — shared pieces of the list / list type / page type tools
 * (docs/lists.md §12): the op-wrapping write-tool factory, the compact
 * text form of a list type the AI reads instead of its JSON, and the
 * "menus are lists" guidance every list tool repeats.
 *
 * Why the tools take the op's own input schema: the list ops validate
 * nested definitions (list types, entry trees, page types) whose shape is
 * owned by `@caelo-cms/shared`. A hand-copied tool schema would drift from
 * it the way the module `fields` schema once did (issue #106); using the
 * op's schema and generating the JSON Schema from it (`generateInputSchema`
 * at registration) keeps one source of truth. The recursive entry tree
 * comes out as `$defs` + `$ref` at the schema root, which every provider
 * accepts (docs/internal/google-models.md).
 */

import { execute } from "@caelo-cms/query-api";
import type { FieldDef, ListTypeDef, NodeDef } from "@caelo-cms/shared";
import type { z } from "zod";
import { describeError, forwardRefusal } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

/**
 * The words the operator uses for lists, said once for every list tool:
 * menus, navigation, footer links, categories and tags ARE lists. Without
 * it the AI looks for a menu tool, or hardcodes links into module HTML.
 */
export const LISTS_ALIAS =
  "Menus, navigation, footer links, categories and tags are SHARED LISTS of a fitting list type (menu, links, categories, tags, or a custom type such as a mega menu) — there are no menu-specific tools. " +
  "A list only ONE module shows stays LOCAL (its entries live in that module's `list` field); a list needed in more than one place, the site navigation, or a vocabulary pages are assigned to is SHARED. promote_local_list switches a local list to shared in one call.";

/**
 * The part of the `list` field contract a module-authoring tool call needs
 * at the call site. The full model (template keys, sources, local vs
 * shared) lives once in the static system prompt's module-model section;
 * repeating ~1.3k characters of it in every always-loaded module tool
 * raised the static context of each chat call (PR #1121 e2e-livedit token
 * ceiling), so the tools carry the binding shapes and the routing only.
 */
export const LIST_FIELD_CONTRACT =
  " **List fields** (`kind:'list'`, `listType`): repeating content is ONE list field, `{{#field}}…{{/field}}` (system prompt: lists). " +
  "local (default): the placement value / chrome `default` is the entries, `[{node:'link', values:{label:'Home', link:{href:'/'}}}]`; " +
  "shared: `bind:'shared'`, `list:'caelo:list/<id>'` — menus, navigation, footer links, categories, tags (list_lists first; entries change via patch_list_items_many; promote_local_list when a second place needs a local list); " +
  "source: `bind:'source'` with a query / system / plugin `source`.";

/**
 * The list ops write their AI-actionable hints with op names ("create it
 * with lists.upsert_many"); the model calls tools, so the tool layer says
 * the tool. Longest names first so `lists.get` never eats a longer name.
 */
const OP_TO_TOOL: readonly (readonly [string, string])[] = [
  ["list_types.upsert_many", "upsert_list_types_many"],
  ["list_types.delete_many", "delete_list_types_many"],
  ["list_types.list", "list_list_types"],
  ["list_types.get", "list_list_types (with slug)"],
  ["lists.patch_items_many", "patch_list_items_many"],
  ["lists.upsert_many", "upsert_lists_many"],
  ["lists.delete_many", "delete_lists_many"],
  ["lists.promote_local", "promote_local_list"],
  ["lists.preview_source", "preview_list_source"],
  ["lists.list", "list_lists"],
  ["lists.get", "get_list"],
  ["page_types.upsert_many", "upsert_page_types_many"],
  ["page_types.delete_many", "delete_page_types_many"],
  ["page_types.list", "list_page_types"],
  ["page_types.get", "list_page_types (with slug)"],
];

/** `text` with list-model op names replaced by the tools that call them. */
export function toolNamesIn(text: string): string {
  let out = text;
  for (const [op, tool] of OP_TO_TOOL) out = out.split(op).join(tool);
  return out;
}

/** Configuration of {@link makeOpTool}. */
export interface MakeOpToolArgs<I> {
  readonly name: string;
  readonly description: string;
  /** The op name, as a string literal at the call site (the parity guard scans for it). */
  readonly opName: string;
  /** The op's own input schema — the tool takes exactly what the op takes. */
  readonly input: z.ZodType<I>;
  /** Render the op's ok-value as the tool's text result. */
  readonly format: (value: unknown, input: I) => string;
}

/**
 * Build a tool that dispatches one op with the tool input unchanged. The
 * JSON Schema is generated from `input` at registration (no hand copy).
 */
export function makeOpTool<I>(args: MakeOpToolArgs<I>): ToolDefinitionWithHandler<I> {
  return {
    name: args.name,
    description: args.description,
    schema: args.input,
    handler: async (ctx, input, toolCtx) => {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, args.opName, input);
      if (!r.ok) {
        return {
          ok: false,
          content: `${args.name} failed: ${toolNamesIn(describeError(r.error))}`,
          ...forwardRefusal(r.error),
        };
      }
      return { ok: true, content: args.format(r.value, input), value: r.value };
    },
  };
}

function describeField(f: FieldDef): string {
  const req = f.required ? "*" : "";
  if (f.type === "term") return `${f.name}${req}:term(${f.list}${f.multiple ? ", many" : ""})`;
  if (f.type === "select") return `${f.name}${req}:select(${f.options.join("|")})`;
  return `${f.name}${req}:${f.type}`;
}

function describeSource(n: NodeDef): string {
  const s = n.source;
  if (!s) return "";
  if (s.kind === "query") {
    const d = Object.entries(s.defaults)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : String(v)}`)
      .join(" ");
    return ` source=query(${d}; editable: ${s.editable.join(", ") || "none"}) → {{#items}}`;
  }
  return ` source=${s.kind}:${s.name} → {{#items}}`;
}

/**
 * One line per node kind: `entry "Menu entry" {label*:text, link*:link}
 * children "children" → entry; current_from=link`. Fields marked `*` are
 * required. This is what the AI needs to write entries and templates; the
 * full JSON stays in the result value.
 */
export function describeListType(def: ListTypeDef): string {
  const lines = [
    `${def.slug} (${def.role}) — ${def.name}: ${def.purpose}`,
    `  top level: ${def.root.allow.join(" | ")}${def.root.max ? ` (max ${def.root.max})` : ""}${def.max_depth ? `; max_depth ${def.max_depth}` : ""}`,
  ];
  for (const [kind, n] of Object.entries(def.nodes)) {
    const kids = n.children
      ? ` children "${n.children.name}" → ${n.children.allow.join(" | ")}`
      : "";
    const current = n.current_from ? `; current_from=${n.current_from}` : "";
    lines.push(
      `  node ${kind} "${n.label}" {${n.fields.map(describeField).join(", ")}}${kids}${describeSource(n)}${current}`,
    );
  }
  return lines.join("\n");
}
