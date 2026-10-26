// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — list type tools (docs/lists.md §3, §12): read, create /
 * change and delete the shapes lists take. `list_list_types` covers both
 * `list_types.list` and, with `slug`, `list_types.get` (which lists and
 * modules use the type) — one read tool, so the AI never has to pick
 * between two.
 */

import { execute } from "@caelo-cms/query-api";
import type { ListTypeDef } from "@caelo-cms/shared";
import { LIST_TYPE_ROLES } from "@caelo-cms/shared";
import { z } from "zod";
import { deleteListTypesManyOp, upsertListTypesManyOp } from "../../ops/lists/list-types.js";
import { describeError } from "./_describe-error.js";
import { describeListType, makeOpTool, toolNamesIn } from "./_list-tool-kit.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listListTypesInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("One type in detail + every list and module using it."),
    role: z.enum(LIST_TYPE_ROLES).optional(),
    query: z.string().min(1).max(128).optional().describe("Free text over slug, name, purpose."),
  })
  .strict();
type ListListTypesInput = z.infer<typeof listListTypesInput>;

interface ListTypeRow {
  slug: string;
  definition: ListTypeDef;
  listCount: number;
  version: number;
  /** The plugin that ships this type (its definition is read-only), or null. */
  ownerPlugin: string | null;
  /** Definition extensions of plugins that are not active (kept, not applied). */
  inertExt: string[];
}

/** Version, list count, plugin ownership and inert extensions of one type. */
function typeFacts(t: ListTypeRow): string {
  const owner = t.ownerPlugin
    ? `; ships with plugin "${t.ownerPlugin}" (read-only definition — use it, or create your own type)`
    : "";
  const inert = t.inertExt.length > 0 ? `; inert plugin settings: ${t.inertExt.join(", ")}` : "";
  return `${t.listCount} shared list(s); version ${t.version}${owner}${inert}`;
}

export const listListTypesTool: ToolDefinitionWithHandler<ListListTypesInput> = {
  name: "list_list_types",
  description:
    "Read the site's list types — the shapes lists take: node kinds, fields (`*` = required), nesting, nodes that generate entries from a source (page query, breadcrumbs, plugin). Read before writing list entries or a module's `{{#field}}…{{/field}}` template (node fields = keys inside the section).\n" +
    "- Menus, navigation, footer links, categories, tags = SHARED LISTS of a fitting type; no menu-specific tools. A list ONE module shows stays LOCAL (entries in its `list` field); used in several places, site navigation or a page vocabulary -> SHARED; `promote_local_list` switches local -> shared.\n" +
    "- Shipped: `texts` (strings), `links` (label + link), `menu` (nested, 3 levels, marks current page), `categories`/`tags` (vocabularies pages are assigned to).\n" +
    "- 'ships with plugin' = read-only definition (fill its lists). 'Inert plugin settings' = extensions of an inactive plugin, kept, not applied.\n" +
    "- No type fits (mega menu with columns + latest news, team list with photo + role) -> `upsert_list_types_many`; don't bend `links`.",
  schema: listListTypesInput,
  handler: async (ctx, input, toolCtx) => {
    if (input.slug !== undefined) {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "list_types.get", {
        slug: input.slug,
      });
      if (!r.ok) {
        return { ok: false, content: `list_list_types: ${toolNamesIn(describeError(r.error))}` };
      }
      const v = r.value as {
        listType: ListTypeRow;
        lists: { slug: string; name: string }[];
        localLists: string[];
      };
      return {
        ok: true,
        content: [
          `${describeListType(v.listType.definition)}\n  ${typeFacts(v.listType)}`,
          `shared lists: ${v.lists.map((l) => `${l.slug} ("${l.name}")`).join(", ") || "none"}`,
          `local lists (module fields / placements): ${v.localLists.join("; ") || "none"}`,
          `definition: ${JSON.stringify(v.listType.definition)}`,
        ].join("\n"),
        value: r.value,
      };
    }
    const { slug: _slug, ...filters } = input;
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "list_types.list", filters);
    if (!r.ok) {
      return { ok: false, content: `list_list_types: ${toolNamesIn(describeError(r.error))}` };
    }
    const rows = (r.value as { listTypes: ListTypeRow[] }).listTypes;
    if (rows.length === 0) {
      return {
        ok: true,
        content: "No list type matches. Create one with upsert_list_types_many.",
        value: r.value,
      };
    }
    return {
      ok: true,
      content: rows.map((t) => `${describeListType(t.definition)}\n  ${typeFacts(t)}`).join("\n"),
      value: r.value,
    };
  },
};

export const upsertListTypesManyTool = makeOpTool({
  name: "upsert_list_types_many",
  description:
    "Create or replace list types (the SHAPE of a list) in one transaction.\n" +
    "DO NOT USE FOR: a near-duplicate of a shipped type (reuse `links`/`menu`); changing a plugin-shipped type (create your own slug).\n" +
    "CORE RULES:\n" +
    "- `nodes`: node kind -> {label, fields, children:{name, allow}, source, current_from}. `root.allow` = top-level node kinds. `purpose` = why the type exists (later reads decide by it). `max_depth` required when a node allows itself.\n" +
    "- Field semantics: `link` value = {href}; `module` = embedded module (`accepts`: module types, absent = any); `term` = entries of vocabulary list `list`. `current_from` names the node's link field that marks the current page.\n" +
    "- Vocabulary types: exactly one node kind, with text fields `name` + `slug`.\n" +
    "- `source` -> generated entries instead of stored children: `query` (`editable` = knobs an entry may change, `defaults` = query), `system`, `plugin`.\n" +
    '- Mega menu example: root.allow ["column","link"]; `column` {fields:[heading text*], children:{name:"links", allow:["link","news"]}}; `link` {fields:[label text*, link link*], current_from:"link"}; `news` {fields:[heading text], source:{kind:"query", editable:["limit"], defaults:{page_type:"news", order:"published_desc", limit:3}}} (`*` = required:true).\n' +
    "- Changes are checked against every list of the type (incl. local lists in modules): a new required field needs a `default`; removing a node kind/field that has values is refused naming the lists -> `dropValues:true` only when the operator agreed to lose them.\n" +
    "- `expectedVersion` from `list_list_types` prevents overwriting a concurrent change.",
  opName: "list_types.upsert_many",
  input: upsertListTypesManyOp.input,
  format: (value) => {
    const rows = (
      value as {
        listTypes: { slug: string; version: number; created: boolean; listsRewritten?: number }[];
      }
    ).listTypes;
    return rows
      .map(
        (t) =>
          `list type ${t.slug} ${t.created ? "created" : "updated"} (version ${t.version}${t.listsRewritten ? `, ${t.listsRewritten} list(s) adapted` : ""})`,
      )
      .join("\n");
  },
});

export const deleteListTypesManyTool = makeOpTool({
  name: "delete_list_types_many",
  description:
    "Delete list types by slug. Refused for plugin-shipped types and while any list (shared, or local in a module field) uses the type — the error names them; delete or convert those first. Undoable. Not for emptying a list (`patch_list_items_many`/`upsert_lists_many`) or dropping one (`delete_lists_many`).",
  opName: "list_types.delete_many",
  input: deleteListTypesManyOp.input,
  format: (value) =>
    `deleted list type(s): ${(value as { deleted: string[] }).deleted.join(", ") || "none"}`,
});
