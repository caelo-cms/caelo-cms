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
import { describeListType, LISTS_ALIAS, makeOpTool, toolNamesIn } from "./_list-tool-kit.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listListTypesInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("One type in detail: its definition plus every list and module using it."),
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
}

export const listListTypesTool: ToolDefinitionWithHandler<ListListTypesInput> = {
  name: "list_list_types",
  description:
    "The list types of this site — the shapes lists take: which node kinds exist, their fields (`*` = required), what may hang under what, and which nodes generate entries from a source (a page query, breadcrumbs, a plugin). " +
    `${LISTS_ALIAS} ` +
    "Shipped types: `texts` (plain strings), `links` (label + link), `menu` (nested entries, 3 levels, marks the current page), `categories` / `tags` (vocabularies pages are assigned to). " +
    "Read this before writing a list's entries or a module's `{{#field}}…{{/field}}` template (the node fields are the keys inside the section). Pass `slug` for one type in detail (lists of the type + modules with local lists of it). " +
    "When no type fits (a mega menu with columns and a latest-news block, a team list with photo + role), create one with upsert_list_types_many instead of bending `links`.",
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
          `${describeListType(v.listType.definition)}\n  version ${v.listType.version}`,
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
      content: rows
        .map(
          (t) =>
            `${describeListType(t.definition)}\n  ${t.listCount} shared list(s); version ${t.version}`,
        )
        .join("\n"),
      value: r.value,
    };
  },
};

export const upsertListTypesManyTool = makeOpTool({
  name: "upsert_list_types_many",
  description:
    "Create or replace list types (1–50 in one call, one transaction). A list type is the SHAPE of a list: `nodes` (node kind → {label, fields[], children?: {name, allow[]}, source?, current_from?}), `root.allow` (node kinds at the top level), `role` (navigation | vocabulary | content), `purpose` (why it exists — later reads decide by it), `max_depth` (required when a node allows itself). " +
    "Field types: text, richtext, link ({href}), media, select (options), boolean, number, date, icon, module (an embedded module), term (entries of a vocabulary list, `list: <slug>`). Vocabulary types need exactly one node kind with text fields `name` and `slug`. " +
    "A node with `source` gets generated entries instead of stored children: {kind:'query', editable:[knobs the entry may change], defaults:{page_type:'news', order:'published_desc', limit:3}} for 'latest news', {kind:'system', name:'breadcrumbs'|'children'|'siblings'|'page_terms'|'term_pages'}, or {kind:'plugin', name}. " +
    'Example — a mega menu: root.allow ["column","link"]; node `column` {fields:[{name:"heading",type:"text",label:"Heading",required:true}], children:{name:"links",allow:["link","news"]}}; node `link` {fields:[label text*, link link*], current_from:"link"}; node `news` {fields:[{name:"heading",type:"text",label:"Heading"}], source:{kind:"query",editable:["limit"],defaults:{page_type:"news",order:"published_desc",limit:3}}}. ' +
    "Changing a type that has lists is checked against every list of the type (local ones in modules too): a new required field needs a `default`; removing a node kind or field that still has values is refused with the lists named — pass `dropValues: true` only when the operator agreed to lose those values. Pass `expectedVersion` from list_list_types to avoid overwriting a concurrent change. " +
    "Do NOT create a near-duplicate of a shipped type — reuse `links` / `menu` when they fit.",
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
    "Delete list types by slug (1–50). Refused while any list (shared, or local in a module field) still uses the type — the error names them; delete or convert those lists first. Undoable like every draft change. " +
    "Do NOT use to empty a list (that is patch_list_items_many / upsert_lists_many) or to drop a list (delete_lists_many).",
  opName: "list_types.delete_many",
  input: deleteListTypesManyOp.input,
  format: (value) =>
    `deleted list type(s): ${(value as { deleted: string[] }).deleted.join(", ") || "none"}`,
});
