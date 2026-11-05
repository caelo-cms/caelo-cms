// SPDX-License-Identifier: MPL-2.0

/**
 * Ops write their AI-actionable hints with op names ("edit that list
 * (lists.patch_items_many)"), because an op does not know which surface
 * called it. The model calls TOOLS, and an op name it cannot call is a
 * dead end (#1264). This map turns the op names a hint may carry into the
 * tool that does the same thing; `describeError` and the tool registry's
 * dispatch apply it to every failed result, so no tool has to remember to.
 *
 * Only ops with one obvious tool equivalent are listed — an op several
 * tools wrap (`pages.set_modules`, `modules.create`) stays as it is rather
 * than naming the wrong tool. Applying the map twice changes nothing.
 */

const OP_TO_TOOL: Readonly<Record<string, string>> = {
  "list_types.upsert_many": "upsert_list_types_many",
  "list_types.delete_many": "delete_list_types_many",
  "list_types.list": "list_list_types",
  "list_types.get": "list_list_types (with slug)",
  "lists.patch_items_many": "patch_list_items_many",
  "lists.upsert_many": "upsert_lists_many",
  "lists.delete_many": "delete_lists_many",
  "lists.promote_local": "promote_local_list",
  "lists.preview_source": "preview_list_source",
  "lists.list": "list_lists",
  "lists.get": "get_list",
  "page_types.upsert_many": "upsert_page_types_many",
  "page_types.delete_many": "delete_page_types_many",
  "page_types.list": "list_page_types",
  "page_types.get": "list_page_types (with slug)",
  "pages.build_page": "build_page",
  "pages.list": "list_pages",
  "pages.update_many": "update_pages_many",
  "pages.update": "update_pages_many",
  "pages.delete_many": "delete_pages_many",
  "pages.delete": "delete_pages_many",
  "pages.duplicate": "duplicate_page",
  "pages.change_template": "repoint_page_template",
  "pages.move_many": "move_pages",
  "pages.set_status_many": "set_pages_status_many",
  "modules.update_many": "update_modules_many",
  "modules.update": "update_modules_many",
  "modules.list": "list_modules",
  "content_instances.set_values_many": "set_content_instance_values_many",
  "content_instances.set_values": "set_content_instance_values_many",
  "content_instances.create_many": "create_content_instances",
  "content_instances.create": "create_content_instances",
  "content_instances.get": "get_content_instance",
  "content_instances.list": "list_content_instances",
  "placement.set_content": "set_placement_content",
  "placement.fork_content": "fork_placement_content",
  "page_module_content.set_many": "set_page_module_content_many",
  "templates.create": "create_template",
  "templates.set_layout": "set_template_layout",
  "templates.list": "list_templates",
  "layouts.list": "list_layouts",
  "themes.update_tokens": "set_theme_tokens",
  "themes.update_meta": "set_theme_meta",
  "themes.set_asset": "set_theme_asset",
  "themes.import": "import_theme",
  "themes.duplicate": "duplicate_theme",
  "pages_seo.set_many": "set_page_seo_many",
  "pages_seo.autofill_many": "autofill_page_seo_many",
  "pages_seo.optimize_many": "bulk_optimize_seo",
  "site_defaults.set": "set_site_defaults",
  "redirects.create_many": "bulk_create_redirects",
  "redirects.list": "find_redirects",
  "static_files.list": "list_static_files",
  "static_files.get": "get_static_file",
  "media.list": "find_media",
  "plugins.list": "list_plugins",
};

/**
 * One alternation of every op name, longest first so `pages.update` never
 * eats `pages.update_many`; bounded so `lists.get` inside a longer
 * identifier (`lists.get_x`, `x.lists.get`) is left alone.
 */
const OP_NAME_RE = new RegExp(
  `(?<![\\w.])(${Object.keys(OP_TO_TOOL)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(".", "\\."))
    .join("|")})(?![\\w])`,
  "g",
);

/** `text` with every op name that has a tool equivalent replaced by that tool. */
export function toolNamesIn(text: string): string {
  return text.replace(OP_NAME_RE, (op) => OP_TO_TOOL[op] ?? op);
}
