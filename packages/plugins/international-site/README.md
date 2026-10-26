# international-site

i18n for Caelo, entirely as a plugin (epic #380; CMS_REQUIREMENTS §7).
Core has no locale concept: this plugin owns the locale registry, the
page variant groups, URL prefixes / hosts, hreflang, the language
switcher source, chrome variants and — since epic #1107 — the
translation of lists. Everything lives in its private schema
`plugin_international_site` (branch-aware, #508: a write from a chat
lands on the chat's branch and goes live with its Stage).

This file documents the list translation (epic #1107 part G). The model
is in `src/list-translation.ts` (pure), the I/O in
`src/list-translation-ops.ts`; core's side is `docs/lists.md` §9.

## How lists are translated

Core gives every stored value an address and lets this plugin answer
the `list-resolve` composition point with an overlay per language:
values by address, plus hidden entries. The site's lists keep their one
structure; a language only replaces texts and hides entries.

What is translated (a *unit*):

| source | address | stored in |
|---|---|---|
| shared list entry field | `list/<listId>/item/<itemId>/<field>` | `list_value_translations` |
| vocabulary entry `name` / `slug` (categories, tags) | `list/<listId>/item/<itemId>/name\|slug` | `term_translations` (slug unique per list and language) |
| local list in a content instance (a module's `list` field) | `instance/<ciId>/<field>/item/<itemId>/<itemField>` — only for the languages of the pages the instance is placed on | `list_value_translations` |
| page property of a language version | `page/<pageId>/props/<field>` — the group's source page holds the text | `page_prop_translations` |

A field is translated when it is `text` or `richtext` and its list type
does not say otherwise: `ext: { "international-site": { translate: false } }`
on the field (the plugin declares this attribute through `listExt`;
core validates it). Text and rich text default to translated — the
plugin's default suggestion; the AI sets `translate: false` in the same
type upsert for values that are the same in every language (SKUs,
codes, brand names). Media alt texts are not translated here: core has
no per-variant address for a media asset's alt text yet.

A layout placement's local list lives in the module's field defaults,
which have no address; its entries are translated with the placement's
chrome variant (`src/chrome-ops.ts`), field by field from the list type
— the same `translate` rule, no guessing from key names. A shared
content instance's local lists go through addresses; its chrome variant
keeps rendering the current entries so an added entry shows up there.

## Change handling

Statuses (`translated | needs_update | missing | orphaned`) are computed
from the source and the stored `source_hash` on every render, so a
chat's preview, the build and the worker agree; the worker
(`translation_staleness_tick`, on list / page / module domain events of
the main line) persists them.

| change | what happens |
|---|---|
| entry added, or `translate` switched on | `missing`; an entry whose REQUIRED translated field is missing is **hidden** on that language's pages (never shown in the source language); a missing optional field renders empty |
| source text changed | `needs_update`; the old translation stays visible until it is redone |
| entry moved | nothing (addresses do not depend on position) |
| entry removed, list deleted, field dropped | `orphaned` — kept, so an undo restores it; deleted once a production build that started after the removal succeeded (`deploy.list_runs`) |
| `translate` switched off | the translation is kept, but no longer applied |
| link to a page without a version in that language | the entry is hidden there, and a finding names it |
| query / system source node | nothing stored: core scopes queries by variant; only the node's own fields (a heading) are units |

The operator can hide an entry in one language on purpose
(`list_item_visibility`, tool `set_list_item_visibility`).

## Tools and surfaces

- `translate_chrome` — one AI pass per language over chrome AND every
  missing / stale list text (paths are addresses); over the Power-MCP it
  returns a work item answered through `apply_translations`.
- `apply_translations` — work item answers, or `kind: "addresses"` with
  `{ address, value }` pairs for a dictated wording. All values are
  checked (field length, required, slug uniqueness) before anything is
  written.
- `set_list_item_visibility` — hide / show entries per language.
- `list_translation_status` — per list and language: counts, per-entry
  states, hidden entries and findings. Feeds the list editor's
  **Languages** tab (`apps/admin/.../content/lists/[slug]/languages`,
  shown while the plugin is active).
- `intl_status` carries `lists` and `listFindings` next to pages and
  chrome.
- `audit_findings` (core's `auditFindingsOperation`) contributes
  `plugin.international-site/list-translation-missing`,
  `…/list-link-target-missing` and `…/page-property-translation-missing`
  warnings to the Stage audit.
- `language_links` is a list source (`listSources`): entries
  `{ href: link, label, locale, is_current: boolean }`, id = locale code.

Without the plugin running there are no variants: lists render their
stored values everywhere.
