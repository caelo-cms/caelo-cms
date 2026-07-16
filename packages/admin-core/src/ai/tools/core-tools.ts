// SPDX-License-Identifier: MPL-2.0

/**
 * The always-loaded core of the tool catalogue.
 *
 * With Anthropic Tool Search enabled (the default), the ~125-tool
 * catalogue no longer ships every description + JSON schema on every
 * call — tools are deferred and the model discovers them through the
 * search tool. Deferring EVERYTHING would add a search round-trip to
 * every routine edit, so the everyday workflow tools listed here keep
 * their full definitions in every request.
 *
 * Keep this list in sync with the `## Tool playbook` block in
 * `../system-prompt.ts`: every tool the playbook presents as the
 * default path for creating / modifying / extending pages must be
 * callable without discovery. The long tail (SEO, redirects, themes,
 * imports, media ops, propose_* gates, genesis, plugins) stays
 * deferred — the playbook names those tools too, and the model loads
 * them via tool search when a task needs them.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Build + page lifecycle
  "build_page",
  "create_page",
  "duplicate_page",
  "update_pages_many",
  "delete_pages_many",
  "set_pages_status_many",
  // Module placement + structure
  "add_module",
  "edit_module",
  "remove_module_from",
  "move_module",
  "reorder_module",
  // Per-page + shared content
  "set_page_module_content",
  "set_page_module_content_many",
  "create_content_instance",
  "set_content_instance_values",
  "set_placement_content",
  "fork_placement_content",
  // Structured sets (nav menus etc.)
  "set_structured_set",
  "get_structured_set",
  // Planning reads + interaction
  "list_pages",
  "list_modules",
  "find_media",
  "offer_choices",
  // Design self-review loop — the AI iterates screenshot -> inspect ->
  // edit_module -> screenshot many times per build (the #155 rounds).
  // These reads fire on every iteration, so deferring them made the
  // model pay a tool-search round-trip per design round (live-edit run
  // 2026-07: 21 toolSearch calls in one turn, several 40-56s loops).
  // They are the hot path of the everyday design workflow, not long tail.
  "get_theme",
  "screenshot_page",
  "inspect_page_render",
  "inspect_built_page",
]);
