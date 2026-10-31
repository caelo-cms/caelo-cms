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
  // Issue #620 — the AI stages when the user asks and re-stages its own
  // quality fixes; "stage it" follows a routine change, so it stays loaded.
  "stage_changes",
  // A page's first Stage needs its meta description (the build refuses
  // pages without one — deploy/missing-seo.ts), so writing it is a step of
  // every page build, not long-tail SEO work.
  "autofill_page_seo_many",
  // The read that step needs: each page's core text (+ stored SEO) in one
  // call, so a description is written without rendering the page.
  "get_page_seo",
  // Build + page lifecycle
  "build_page",
  "duplicate_page",
  "update_pages_many",
  // "Put X under Y" is routine page structuring — no discovery round-trip.
  "move_pages",
  "delete_pages_many",
  "set_pages_status_many",
  // Module placement + structure. Every write tool here is the bulk form
  // (one item = the n=1 case); the retired singular names alias to them
  // without being offered (retired-tools.ts).
  "add_module",
  "update_modules_many",
  // Surgical read/edit over module + template bodies (Claude-Code-style).
  // Hot path of the everyday edit loop — read a body, string-replace it —
  // so they stay loaded rather than behind a tool-search round-trip.
  // grep_content is the long-tail "find it across the catalog" case and
  // stays deferred.
  "read_content",
  "edit_content",
  "remove_module_from",
  "move_module",
  // Per-page + shared content
  "set_page_module_content_many",
  "create_content_instances",
  "set_content_instance_values_many",
  "set_placement_content",
  "fork_placement_content",
  "list_content_instances",
  "get_content_instance",
  // Planning reads. (offer_choices is deliberately NOT core: keeping the
  // ask-the-operator button always loaded lowered the model's threshold
  // to stall on questions it can answer itself — clean-DB footer run
  // 2026-07 ended its turn on offer_choices instead of just creating the
  // missing link-target pages. Deferred, it's still reachable via tool
  // search for GENUINE trade-offs.)
  "list_pages",
  "list_modules",
  "find_media",
  // The reads `build_page` sends the model to: its `templateId`, block
  // names and `pageType` come from these. Deferred, the first page build of
  // nearly every chat paid a tool search for them (20 e2e-livedit runs,
  // 2026-10-26: list_templates 73, list_layouts 67, list_page_types 34
  // calls, each chat's first use behind a search). A search is one more
  // model pass over the whole context plus the loaded definitions as
  // uncached input (50–130k tokens of input per search call measured); the
  // three definitions cost ~0.8k tokens of cached prefix per call.
  "list_templates",
  "list_layouts",
  "list_page_types",
  // Epic #1107 — "add Careers to the menu" / "fix the footer link" is an
  // everyday edit: find the shared list, read its entry ids, patch it.
  // Creating lists stays deferred (the manage-menu and manage-page-types
  // skills name those tools when loaded).
  "list_lists",
  "get_list",
  "patch_list_items_many",
  // A custom list type is part of an ordinary build: feature cards with an
  // icon, a heading and a text are entries of their own type. Deferred, the
  // homepage loaded it by tool search mid-build, and that one search cost
  // 61k uncached input tokens (e2e-livedit run 40375971522: 327.6k new input
  // against ~170k without it), while the compact definition costs ~750
  // tokens of cached prefix (_list-tool-schemas.ts).
  "upsert_list_types_many",
  // Design self-review loop — the AI iterates screenshot -> inspect ->
  // update_modules_many -> screenshot many times per build (the #155 rounds).
  // These reads fire on every iteration, so deferring them made the
  // model pay a tool-search round-trip per design round (live-edit run
  // 2026-07: 21 toolSearch calls in one turn, several 40-56s loops).
  // They are the hot path of the everyday design workflow, not long tail.
  "get_theme",
  "screenshot_page",
  "inspect_page_render",
  // inspect_built_page (the staged build, GCP only) is the rarer check after
  // a Stage — deferred behind tool search, still registered.
  // The AI's defect channel — a bug can surface at ANY moment, and an
  // AI that must tool-search for the reporting channel while confused
  // defeats the purpose (2026-07, run B4 selector-crop diagnosis).
  "bug_report",
  // #1275 — every kept failure (a wrong page type in a build_page, a bad
  // field value) names retry_tool_call as its fix. Deferred, the fix would
  // pay a tool search first (50–130k uncached input tokens, see the reads
  // above) to save a resend; loaded, it costs a short definition of cached
  // prefix.
  "retry_tool_call",
  // Progressive-disclosure skills entry point. The `## Skills` index lists
  // every active skill; the model calls load_skill the moment a task matches
  // one. Deferring it behind tool search would add a discovery round-trip in
  // front of EVERY skill activation — the opposite of the point. Cheap schema.
  "load_skill",
]);
