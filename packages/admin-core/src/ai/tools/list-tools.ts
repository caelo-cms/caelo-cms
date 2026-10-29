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
import { makeOpTool } from "./_list-tool-kit.js";
import {
  PATCH_LIST_ITEMS_JSON_SCHEMA,
  PREVIEW_LIST_SOURCE_JSON_SCHEMA,
  UPSERT_LISTS_JSON_SCHEMA,
} from "./_list-tool-schemas.js";
import { makeListReadTool } from "./_make-read-tool.js";

/**
 * Operator words -> lists. Said once, in list_lists, where the AI looks for
 * a menu: every catalogue tool counts toward each call's input.
 */
const MENUS_ARE_LISTS =
  "Menus, nav, footer links, categories, tags = SHARED LISTS of a fitting type (menu, links, categories, tags, custom e.g. mega menu); no menu-specific tools. Shown by ONE module -> LOCAL (its `list` field); >1 place, site nav or a page vocabulary -> SHARED (`promote_local_list` converts).";

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
    "The site's SHARED lists (TOON rows): slug, type, role, entry count, purpose, binding module fields (module.field), placements, sample pages, vocabulary use, last edit. Entries -> `get_list`.\n" +
    "Call BEFORE creating a list: 'add Careers to the menu' -> the header's list is here (usedBy = header module) -> patch it, never mint a second menu.\n" +
    `${MENUS_ARE_LISTS} Local lists are not listed here -> \`list_modules\`.`,
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
    "One shared list (by `slug` or `id`): entry tree (ids, node kinds, values, links as paths), `version`, usage. Read before `patch_list_items_many`: patches address entries by id (Careers under Company -> `parentId` = Company's id); pass `version` as `expectedVersion`.",
  opName: "lists.get",
  input: getListOp.input,
  format: (value) => {
    const l = (value as { list: ListSummaryRow & { items: ListItemInput[] } }).list;
    const lines = [
      // Read keys mirror the write keys (upsert_lists_many takes `items`;
      // the role belongs to the type): the AI copied an earlier "entries:"
      // heading and the role into a write call (release gate, v0.11.0).
      `list ${l.slug} (${l.id}) — type ${l.type} (role ${l.role}, set by the type), version ${l.version}, ${l.itemCount} entries`,
      `purpose: ${l.purpose}`,
      `used by: ${usedBy(l.usage) || "no module"}; ${l.usage.placementCount} placement(s); sample pages: ${l.usage.samplePages.map((p) => p.path).join(", ") || "none"}`,
      "items:",
    ];
    renderItems(l.items, 0, lines);
    return lines.join("\n");
  },
});

export const upsertListsManyTool = makeOpTool({
  name: "upsert_lists_many",
  description:
    "Create shared lists (menus, footer links, vocabularies) or replace a list's WHOLE entry tree (one tx). A few entries -> `patch_list_items_many` (a replace drops every omitted entry).\n" +
    "CORE RULES:\n" +
    "- `purpose` = why + where it shows ('Main navigation in the site header'). The tree is `items` (not `entries`); the role comes from the type.\n" +
    "- Entry: terms `caelo:term/<listId>/<itemId>`; `children` only under nodes allowing them; `query` only on source nodes, only knobs its source lists in `editable` (e.g. {limit:5}); omit = type `defaults`.\n" +
    "- Links `{href}`: path of an EXISTING page (`list_pages`; else empty shell first: `build_page` with `modules: []`); `/`, `/#section` always valid; import-run pages rebuilt in this chat are kept for `resolve_import_links`; external = full `https://` URL.\n" +
    '- E.g. (menu): [{"node":"entry","values":{"label":"Company","link":{"href":"/about"}},"children":[{"node":"entry","values":{"label":"Team","link":{"href":"/about/team"}}}]}]\n' +
    "Then bind it: module `list` field `bind:'shared'`, `list:'caelo:list/<id>'` (`add_module` / `update_modules_many`), e.g. the layout header.",
  inputSchema: UPSERT_LISTS_JSON_SCHEMA,
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
    "Edit shared-list entries by id — the routine way to maintain a menu, footer links or a vocabulary (one tx). Every page showing the list updates; nothing to rewire. Result names added entry ids.\n" +
    "`add`: omit `parentId` = top level, omit `position` = append. `update`: `values` merged, `null` removes a value. `remove`: drops its children too.\n" +
    "'Add Careers under Company' = `get_list` -> one `add` with `parentId` = Company's id. Pass `expectedVersion` from `get_list`; conflict = list changed -> re-read, redo.",
  inputSchema: PATCH_LIST_ITEMS_JSON_SCHEMA,
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
    "Delete shared lists by slug (undoable). Refused while a module field/placement binds one (error names them) -> rebind/remove first. Entries -> `patch_list_items_many`; list types -> `delete_list_types_many`.",
  opName: "lists.delete_many",
  input: deleteListsManyOp.input,
  format: (value) =>
    `deleted list(s): ${(value as { deleted: string[] }).deleted.join(", ") || "none"}`,
});

export const promoteLocalListTool = makeOpTool({
  name: "promote_local_list",
  description:
    "Turn a module's LOCAL list into a SHARED list and bind the field to it, in one call — when a second place needs the same entries ('footer links in the mobile menu too', 'editors maintain these links without opening the module'). `field` = the module's `list` field. " +
    "Refused when placements show different entries (names them) -> pick the entries to keep, use `upsert_lists_many` + `update_modules_many`. Returns list id + ref `caelo:list/<id>` for binding other modules.",
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
    "Show what a generated list (page query, system or plugin source) returns for a page BEFORE binding/saving it; same resolver as preview + build, this chat's draft view. Only published pages appear; empty = wrong filter (page type slug, terms) or nothing published yet.\n" +
    "E.g. `source`:{kind:'query', editable:['limit'], defaults:{page_type:'news', order:'published_desc', limit:3}}.\n" +
    "`pageId` = page it renders on; needed for breadcrumbs/children/siblings/page_terms; a query excludes that page.",
  inputSchema: PREVIEW_LIST_SOURCE_JSON_SCHEMA,
  opName: "lists.preview_source",
  input: previewListSourceOp.input,
  format: (value) => {
    const v = value as {
      source: string;
      count: number;
      total: number;
      pagination?: { perPage: number; pageCount: number; followUps: string };
      items: Record<string, unknown>[];
    };
    if (v.count === 0) return `${v.source}: no entries for this page.`;
    // #1257 — a cut list says so: the AI decides teaser (fine) vs overview (paginate).
    const head = v.pagination
      ? `${v.source}: page 1 of ${v.pagination.pageCount} (${v.count} of ${v.total}, ${v.pagination.perPage} per page, follow-up pages ${v.pagination.followUps})`
      : v.total > v.count
        ? `${v.source}: shows ${v.count} of ${v.total} matching pages — an overview must list all: set paginate on the field`
        : `${v.source}: ${v.count} entr${v.count === 1 ? "y" : "ies"}`;
    return [head, ...v.items.map((e) => `- ${JSON.stringify(e)}`)].join("\n");
  },
});
