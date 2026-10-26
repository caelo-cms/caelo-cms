// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — shared list tools (docs/lists.md §4, §7, §12): the site's
 * menus, footer links, categories, tags and any other list more than one
 * place shows. Reads come back with internal links as paths (the ops are
 * humanised, epic #724); writes take paths and store references.
 *
 * `patch_list_items_many` is the routine edit ("add Careers under
 * Company" is one `add` patch): it addresses entries by id, so the AI
 * never resends — and never accidentally reorders or drops — a whole tree
 * for a one-entry change.
 */

import type { ListItemInput } from "@caelo-cms/shared";
import type { z } from "zod";
import {
  deleteListsManyOp,
  getListOp,
  listListsOp,
  patchListItemsManyOp,
  upsertListsManyOp,
} from "../../ops/lists/lists.js";
import { previewListSourceOp } from "../../ops/lists/preview-source.js";
import { promoteLocalListOp } from "../../ops/lists/promote-local.js";
import { LISTS_ALIAS, makeOpTool } from "./_list-tool-kit.js";
import { makeListReadTool } from "./_make-read-tool.js";

interface ListUsageView {
  modules: { slug: string; field: string }[];
  placementCount: number;
  samplePages: { path: string }[];
  pageTypes: string[];
  taggedPageCount: number;
}

interface ListSummaryRow {
  id: string;
  slug: string;
  name: string;
  purpose: string;
  type: string;
  role: string;
  itemCount: number;
  version: number;
  updatedAt: string;
  usage: ListUsageView;
}

function usedBy(u: ListUsageView): string {
  return u.modules.map((m) => `${m.slug}.${m.field}`).join(" ");
}

/**
 * The op's filters; the read-tool factory extends them with the list
 * params. `includeItems` is left out: a TOON row cannot show a tree, and
 * get_list is the AI's way to read entries.
 */
const listListsInput = (listListsOp.input as unknown as z.ZodObject<z.ZodRawShape>).omit({
  includeItems: true,
});

export const listListsTool = makeListReadTool<Record<string, unknown>, ListSummaryRow>({
  name: "list_lists",
  description:
    `The shared lists of this site (TOON rows): slug, type, role, entry count, purpose, which module fields bind it (module.field), placements, sample pages, vocabulary use (page types + tagged pages), last edit. ${LISTS_ALIAS} ` +
    "Call it BEFORE creating a list — when the operator says 'add Careers to the menu', the header's list is here (usedBy shows the header module), so you patch it instead of minting a second menu. " +
    "Filters: `type` (list type slug), `role` (navigation | vocabulary | content), `query` (free text over slug, name, purpose and entry text), plus the standard list params. " +
    "Entries are in get_list; local lists (inside one module) are not listed here — list_modules shows them.",
  opName: "lists.list",
  input: listListsInput,
  label: "lists",
  rows: (value) => (value as { lists: ListSummaryRow[] }).lists,
  columns: [
    { key: "slug", value: (l) => l.slug },
    { key: "id", value: (l) => l.id },
    { key: "type", value: (l) => l.type },
    { key: "role", value: (l) => l.role },
    { key: "items", value: (l) => String(l.itemCount) },
    { key: "purpose", value: (l) => l.purpose },
    { key: "usedBy", value: (l) => usedBy(l.usage) },
    { key: "placements", value: (l) => String(l.usage.placementCount) },
    { key: "samplePages", value: (l) => l.usage.samplePages.map((p) => p.path).join(" ") },
    {
      key: "vocabularyOf",
      value: (l) =>
        l.usage.pageTypes.length > 0
          ? `${l.usage.pageTypes.join(" ")} (${l.usage.taggedPageCount} pages)`
          : "",
    },
    { key: "version", value: (l) => String(l.version) },
    { key: "updatedAt", value: (l) => l.updatedAt },
  ],
  emptyMessage:
    "No shared lists on this site yet. Create one with upsert_lists_many (list_list_types shows the types).",
});

function renderItems(items: readonly ListItemInput[], depth: number, out: string[]): void {
  for (const it of items) {
    const query = it.query ? ` query=${JSON.stringify(it.query)}` : "";
    out.push(
      `${"  ".repeat(depth)}- [${it.id ?? "?"}] ${it.node} ${JSON.stringify(it.values ?? {})}${query}`,
    );
    if (it.children) renderItems(it.children, depth + 1, out);
  }
}

export const getListTool = makeOpTool({
  name: "get_list",
  description:
    "One shared list with its whole entry tree (by `slug` or `id`): every entry's id, node kind and values (links as paths), its version, and where the list is used. " +
    "Read it before patch_list_items_many — patches address entries by id (`parentId` of 'Company' to add 'Careers' under it) — and pass `version` back as `expectedVersion`.",
  opName: "lists.get",
  input: getListOp.input,
  format: (value) => {
    const l = (value as { list: ListSummaryRow & { items: ListItemInput[] } }).list;
    const lines = [
      `list ${l.slug} (${l.id}) — type ${l.type}, ${l.role}, version ${l.version}, ${l.itemCount} entries`,
      `purpose: ${l.purpose}`,
      `used by: ${usedBy(l.usage) || "no module"}; ${l.usage.placementCount} placement(s); sample pages: ${l.usage.samplePages.map((p) => p.path).join(", ") || "none"}`,
      "entries:",
    ];
    renderItems(l.items, 0, lines);
    return lines.join("\n");
  },
});

export const upsertListsManyTool = makeOpTool({
  name: "upsert_lists_many",
  description:
    `Create shared lists, or replace a list's WHOLE entry tree (1–50 lists, one transaction). ${LISTS_ALIAS} ` +
    "Each list: `slug`, `name`, `purpose` (why it exists and where it shows — e.g. 'Main navigation in the site header'), `type` (list type slug from list_list_types), `items` (the entry tree). " +
    'An entry is {node, values, children?, query?}: `values` keyed by the node\'s fields (links as {"href": "/about"} or an external URL; terms as caelo:term/<listId>/<itemId>), `children` under nodes that allow them, `query` only on source nodes and only with the knobs that node\'s source lists in `editable` (e.g. {limit:5}) — page_type, order and the rest are fixed by the type\'s `defaults`; omit `query` to use them as they are. Keep the `id` of entries that already exist; omit it for new ones. ' +
    'Example (type menu): [{"node":"entry","values":{"label":"Company","link":{"href":"/about"}},"children":[{"node":"entry","values":{"label":"Team","link":{"href":"/about/team"}}}]}]. ' +
    "Links must name pages that exist (build them first). To change a few entries of an existing list prefer patch_list_items_many — a replace drops every entry you leave out. After creating a list, bind it: a module `list` field with bind 'shared' (add_module / update_modules_many), e.g. the header module on the layout.",
  opName: "lists.upsert_many",
  input: upsertListsManyOp.input,
  format: (value) =>
    (
      value as {
        lists: {
          id: string;
          slug: string;
          version: number;
          created: boolean;
          itemCount: number;
          sourceEntries: { id: string; node: string }[];
        }[];
      }
    ).lists
      .map(
        (l) =>
          `list ${l.slug} ${l.created ? "created" : "replaced"}: id=${l.id} ref=caelo:list/${l.id} version ${l.version}, ${l.itemCount} entries` +
          (l.sourceEntries.length > 0
            ? `; source entries (preview_list_source itemId): ${l.sourceEntries.map((e) => `${e.id} (${e.node})`).join(", ")}`
            : ""),
      )
      .join("\n"),
});

export const patchListItemsManyTool = makeOpTool({
  name: "patch_list_items_many",
  description:
    "Edit entries of shared lists by id — the routine way to maintain a menu, footer links or a vocabulary (1–50 lists, up to 200 patches each, one transaction). " +
    "Patches: {op:'add', parentId?, position?, item:{node, values, children?}} (omit parentId for the top level, position to append), {op:'update', itemId, values} (merged; null removes a value), {op:'move', itemId, parentId?, position}, {op:'remove', itemId} (with its children). " +
    "'Add Careers under Company' = get_list → one add patch with parentId = Company's id. Pass `expectedVersion` from get_list; a conflict means someone changed the list — re-read and redo. " +
    "The result names the ids of added entries. Every page that shows the list updates with it — there is nothing to rewire.",
  opName: "lists.patch_items_many",
  input: patchListItemsManyOp.input,
  format: (value) =>
    (value as { lists: { slug: string; version: number; addedItemIds: string[] }[] }).lists
      .map(
        (l) =>
          `list ${l.slug} patched (version ${l.version})${l.addedItemIds.length > 0 ? `; added entry ids: ${l.addedItemIds.join(", ")}` : ""}`,
      )
      .join("\n"),
});

export const deleteListsManyTool = makeOpTool({
  name: "delete_lists_many",
  description:
    "Delete shared lists by slug (1–50). Refused while a module field or placement still binds the list (the error names them) — rebind or remove those first. Undoable like every draft change. " +
    "Do NOT use to remove entries (patch_list_items_many) or a list type (delete_list_types_many).",
  opName: "lists.delete_many",
  input: deleteListsManyOp.input,
  format: (value) =>
    `deleted list(s): ${(value as { deleted: string[] }).deleted.join(", ") || "none"}`,
});

export const promoteLocalListTool = makeOpTool({
  name: "promote_local_list",
  description:
    "Turn a module's LOCAL list into a SHARED list and bind the field to it, in one call — when a second place needs the same entries ('show the footer links in the mobile menu too', 'the editors should maintain these links without opening the module'). " +
    "Input: `moduleId` + `field` (the module's `list` field), and the new list's `slug`, `name`, `purpose`. Refused when the module's placements show different entries (it names them) — then decide which entries the shared list keeps and use upsert_lists_many + update_modules_many instead. " +
    "Result: the list id and its ref (caelo:list/<id>) for binding other modules.",
  opName: "lists.promote_local",
  input: promoteLocalListOp.input,
  format: (value) => {
    const v = value as { listId: string; listRef: string; itemCount: number };
    return `local list promoted: shared list id=${v.listId} ref=${v.listRef}, ${v.itemCount} entries; the field now binds it.`;
  },
});

export const previewListSourceTool = makeOpTool({
  name: "preview_list_source",
  description:
    "Show what a generated list returns for a page BEFORE you bind or save it: a page query ('the 3 latest news'), a system source (breadcrumbs, children, siblings, page_terms, term_pages) or a plugin source — the same resolver the preview and the build use, in this chat's draft view. " +
    "Name it ONE way: `source` (+ `value` overrides, `vocabulary` for page_terms) — e.g. {source:{kind:'query', editable:['limit'], defaults:{page_type:'news', order:'published_desc', limit:3}}}; `list` + `itemId` (a saved source node of a shared list, e.g. the mega menu's news column); `list` + `node` + `value` (a source node kind of the list's type with the knobs you are about to save); or `moduleId` + `field` (+ `contentInstanceId`) for a module's source field. " +
    "`pageId` = the page it renders on (needed for breadcrumbs / children / siblings / page_terms; a query leaves that page out by default). Only published pages appear. An empty result usually means the filter is wrong (page type slug, terms) or nothing is published yet.",
  opName: "lists.preview_source",
  input: previewListSourceOp.input,
  format: (value) => {
    const v = value as { source: string; count: number; items: Record<string, unknown>[] };
    if (v.count === 0) return `${v.source}: no entries for this page.`;
    return [
      `${v.source}: ${v.count} entr${v.count === 1 ? "y" : "ies"}`,
      ...v.items.map((e) => `- ${JSON.stringify(e)}`),
    ].join("\n");
  },
});
