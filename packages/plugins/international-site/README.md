# international-site

i18n for Caelo, entirely as a plugin (epic #380; CMS_REQUIREMENTS §7).
Core has no locale concept: this plugin owns the locale registry, the
page variant groups, URL prefixes / hosts, hreflang, the language
switcher source, chrome variants and — since epic #1107 — the
translation of lists. Everything lives in its private schema
`plugin_international_site` (branch-aware, #508: a write from a chat
lands on the chat's branch and goes live with its Stage).

This file documents the list translation (epic #1107 part G), what a
page translation covers, and the plugin's own checks of a staged build.
The list model is in `src/list-translation.ts` (pure), the I/O in
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
- `audit_findings` (core's `auditFindingsOperation`) contributes the
  checks below to the Stage audit, including the list warnings
  `plugin.international-site/list-translation-missing`,
  `…/list-link-target-missing` and `…/page-property-translation-missing`.
- `write_hints` (core's `writeHintsOperation`) tells the AI in the tool
  result when a module or content write hardcodes a link into another
  language (`src/write-hints.ts`).
- Skill `international-qa` says how to fix each finding.
- `language_links` is a list source (`listSources`): entries
  `{ href: link, label, locale, is_current: boolean }`, id = locale code.
- `editor_languages` answers the plugin's place in the live editor's
  toolbar (`editorToolbar`, `docs/plugin-editor-toolbar.md`): the shown
  page's language code, its other versions (each opens in the editor),
  and the out-of-date ones counted. A language without a version reads
  "Not translated" without a tone: that URL is a clean 404 by design.
  The state is computed in `src/editor-toolbar.ts` (pure).

Without the plugin running there are no variants: lists render their
stored values everywhere.

## What a page translation covers

`translate_variant` (`src/page-translation.ts`) offers the translator
every text the page shows, read through `page_module_content.list_for_page`:

- the stored values of each placement;
- the defaults of fields the placement stores no value for. The module
  extractor turns literal copy (button labels, form labels, menu
  entries) into such defaults, so this is where a module's "fixed" text
  lives;
- the entries of the page's own local lists (paths `field[<entry>].key`,
  as for chrome);
- nested content (`module` / `module-list` values, also inside list
  entries), one slot per nested instance, at its path (`cards[2]`).

The translation is written into the VARIANT's own values: a default
becomes the variant's stored value, a list takes the source's entries
with the variant's text, and nested content is written to the variant's
own instance. `create_variant` copies nested content (pages.duplicate
deep-copies it), so a new variant always owns it. Nested content another
page renders too (variants created before that) is left as it is and
named in `sharedNested`, with `fork_placement_content` as the next step:
writing it would change the other page.

## Checks of the staged build

`src/audit-rules.ts` (pure), `src/audit.ts` (I/O). The first call
answers the rules from the plugin's data and asks for the page facts in
batches that keep each language group together; each batch is checked
against the facts core extracted from the rendered pages
(`docs/quality-checks.md`, "Page facts"). What core's `links` and
`references` checks report is not repeated; these rules name the
language cause. A finding about shared markup (a module, the page
template) names no page and is filed once.

`error` blocks Publish live (a visitor or a search engine gets something
broken or wrong), `warning` and `info` are reported. A missing
translation is never an error: it is a clean 404 by design.

| Rule | Severity | Finds |
|---|---|---|
| `hardcoded-language-link` | error | a language link (hreflang attribute, language name as text, or a language's home) that does not lead to the current page's version: fixed markup instead of `language_links` |
| `switcher-to-home` | warning | a language link to the other language's home although the page has a version there |
| `switcher-missing` | warning | pages with several published versions offer no link to them |
| `cross-locale-content-link` | warning | a content link into another language although the target exists in the page's own |
| `hreflang-self-missing` | error | the page is missing from its own hreflang set |
| `hreflang-missing-version` | error | a published version is missing from the set |
| `hreflang-not-reciprocal` | error | an alternate does not name the page back |
| `hreflang-target-broken` | error | an alternate is not a page of the build |
| `hreflang-target-not-indexable` | error | an alternate is noindex or canonical to another URL |
| `hreflang-invalid-code` | error | not a BCP 47 tag, a wrong region (`en-UK`), or a code listed twice |
| `x-default-missing` | warning | no `x-default`, or not the default language's version |
| `canonical-cross-locale` | error | a version's canonical names another language's version |
| `sitemap-alternates-mismatch` | error | the sitemap's alternates differ from the head's |
| `html-lang-mismatch` | error | `<html lang>` is not the page's language |
| `og-locale-mismatch` | info | `og:locale` names another language |
| `content-wrong-language` | error | at least half of a version's text (200+ characters) is identical to its source |
| `content-mixed-language` | warning | some text of a version is still the source's |
| `chrome-untranslated` | warning | header, footer or menu show the source language's text |
| `alt-untranslated` | warning | image alt texts are the source's |
| `seo-untranslated` | error | title or meta description identical to the source's |
| `glossary-violation` | warning | a glossary term used where the glossary says otherwise |
| `locale-format` | info | numbers in another language's format (`1.234,56` on an English page) |
| `slug-untranslated` | info | a version's slug is its source's |
| `translation-stale` | warning | a published version whose source changed after translation |
| `chrome-translation-stale` | warning | the same for shared content |
| `locale-empty` | warning | a registered language without published pages |
| `locale-home-missing` | error | a language with published pages but no published home |
| `variant-group-broken` | error | two pages of one language in a group, or a group without source |
| `coverage` | info | pages per language |

Text that is the same in every language on purpose (a brand or product
name) is a glossary entry with itself as the translation; it is then
never counted as untranslated.

Not covered yet: links between hosts of the `subdomain` / `domain`
strategies (only URLs on the site's own hosts have a path in the facts).
