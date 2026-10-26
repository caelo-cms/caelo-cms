# Lists, list types and page types

Epic #1107. This is the developer reference for Caelo's structured data:
**lists** (menus, link groups, categories, tags, any repeated data), the
**list types** that define their shape, **page types** with properties and
vocabularies, and the **sources** a list's entries can come from. It
replaced structured sets, the `text-list` / `link-list` module field kinds
and `templates.kind`.

## 1. The model in one paragraph

A list is a tree of entries. A list type defines which entry kinds
(*nodes*) exist, which fields each has, what may hang under what, and
whether a node is filled from a source instead of stored children. A
module reads a list through a field of kind `list` and iterates it with
`{{#field}}…{{/field}}` — the same syntax whether the list is local to the
module, shared, the result of a page query, a system source
(breadcrumbs …) or a plugin source. Pages carry a page type, properties
and terms (entries of vocabulary lists), which is what page queries filter
on. Core knows no languages: translation is done by a plugin through
neutral hooks (section 9).

Words the AI and the operator use map onto this one concept: a *menu*,
*navigation*, *footer links*, *categories* and *tags* are shared lists of a
fitting type. There are no menu-specific tools.

## 2. Field system

`packages/shared/src/lists/fields.ts`. One set of field types for list
nodes and page-type properties.

| type | stored value | template | notes |
|---|---|---|---|
| `text` | string | `{{f}}` | `maxLength` (default 500) |
| `richtext` | string (sanitised HTML, same rules as module richtext) | `{{f}}` | `maxLength` (default 5000) |
| `link` | `{ href: string, target?: "_self" \| "_blank" }`; `href` is `caelo:page/<id>…` or an absolute/relative URL | `{{f}}` = href, `{{f.href}}`, `{{f.target}}`, `{{f.title}}` (internal page title, else "") | `href` canonicalised to a reference on write (epic #724) |
| `media` | `caelo:media/<id>` string | `{{f}}` = url, `{{f.url}}`, `{{f.alt}}`, `{{f.width}}`, `{{f.height}}` | |
| `select` | one of `options` | `{{f}}`, and `{{#f_<option>}}` is true when selected | `options: string[]` (snake_case values) |
| `boolean` | boolean | `{{#f}}…{{/f}}` | |
| `number` | number | `{{f}}` | `min`, `max` |
| `date` | ISO date `YYYY-MM-DD` | `{{f}}` = ISO, `{{f.formatted}}` (site language) | |
| `icon` | icon name (`[a-z0-9-]+`) | `{{f}}` = name | the module maps names to its own sprite / icon font |
| `module` | `{ moduleId, contentInstanceId }` | `{{>f}}` | `accepts?: string[]` module types; the entry is the content holder, so this works in site chrome |
| `term` | `string[]` of `caelo:term/<listId>/<itemId>` | `{{#f}}{{name}}{{/f}}` iterates the referenced vocabulary entries | `list: <vocabulary list slug>`, `multiple: boolean` |

Field definition (Zod `fieldDefSchema`):

```ts
{
  name: string;            // snake_case, ^[a-z][a-z0-9_]{0,63}$, not reserved
  label: string;           // human label, 1..128
  type: FieldType;
  required?: boolean;      // default false
  default?: unknown;       // validated against the type
  ext?: Record<string, unknown>; // plugin-declared attributes, keyed by plugin slug (section 9)
  // per type: maxLength (text, richtext), options (select), min/max (number),
  // accepts (module), list + multiple (term)
}
```

Reserved names (cannot be field, node or children names): `id node index
depth first last items page recurse`, and any name starting `is_`, `has_`,
`count_`.

## 3. List types

`packages/shared/src/lists/list-type.ts`, Zod `listTypeDefSchema`.

```ts
{
  slug: string;              // ^[a-z0-9-]+$
  name: string;
  purpose: string;           // why this type exists (CLAUDE.md §1A), 1..1000
  role: "navigation" | "vocabulary" | "content";
  root: { allow: string[]; max?: number };   // node kinds at the top level
  nodes: Record<string, NodeDef>;            // key = node kind, snake_case
  max_depth?: number;        // 1..8; REQUIRED when any node allows itself (directly or via a cycle)
}

NodeDef = {
  label: string;
  fields: FieldDef[];        // may be empty (a separator)
  children?: { name: string; allow: string[]; max?: number }; // name = loop name in templates
  current_from?: string;     // name of a link field: drives is_current / is_ancestor
  source?: SourceDef;        // node gets generated children named `items`; no stored children
}

SourceDef =
  | { kind: "query"; editable: QueryKnob[]; defaults: Partial<PageQuery> }
  | { kind: "system"; name: SystemSourceName }
  | { kind: "plugin"; name: string }   // a list source an active plugin declared
```

Static rules (`checkListTypeDef`, returns AI-actionable issues):
unknown node kind in any `allow`; a recursive kind without `max_depth`;
`current_from` naming a non-link field; duplicate field names in a node;
reserved names; `children` and `source` together; vocabulary types
(`role: "vocabulary"`) must have exactly one node kind with a `text` field
named `name` and a `text` field named `slug`.

### Shipped types

Seeded as stored data (migration 0352), editable like any other type:

| slug | role | nodes |
|---|---|---|
| `texts` | content | `text` {text: text required} |
| `links` | content | `link` {label: text required, link: link required} |
| `menu` | navigation | `entry` {label, link} → children `children` allow `entry`; `max_depth: 3`; `current_from: link` |
| `categories` | vocabulary | `category` {name, slug, description: richtext, landing_page: link} → children `children` allow `category`; `max_depth: 6` |
| `tags` | vocabulary | `tag` {name, slug, color: text} |

`packages/shared/src/lists/default-types.ts` exports them (the migration
and tests use the same objects).

### Changing a type that has lists

`list_types.upsert_many` validates the new definition against every list
of that type, local lists inside modules included, in the same
transaction. A new required field needs a `default` (applied to existing
entries). Removing a node kind or field that still has values is refused
with the affected lists named, unless the input sets `dropValues: true`.
Every change snapshots and is undoable.

## 4. Lists and entries

Shared list (`lists` table) and local list (a module field value) store
the same entry array:

```ts
ListItem = {
  id: string;                     // uuid, assigned on write when absent, never changes
  node: string;                   // node kind
  values: Record<string, unknown>;// per the node's fields
  children?: ListItem[];          // stored under the node's children; key name is ALWAYS "children" in storage
  query?: Partial<PageQuery>;     // only on source nodes of kind query; only `editable` knobs
}
```

Storage keeps children under `children` regardless of the loop name; the
loop name (`children.name`) is a template concern. Validation
(`validateListItems(type, items)`): node allowed at its position, required
fields, value shape per field type, depth ≤ `max_depth` (≤ 8), ≤ 500
entries per list, `max` per level, query knobs only from `editable`,
`limit` ≤ 50, no `module` field that embeds a module rendering the same
list (checked by the op with DB access). Errors carry the entry path
(`items[2].children[0].values.label`) and the next step.

## 5. Page types, properties, terms

`packages/shared/src/lists/page-type.ts`, Zod `pageTypeDefSchema`:

```ts
{
  slug: string; name: string; purpose: string;
  templates: string[];            // template ids allowed for pages of this type (non-empty)
  defaultTemplate: string;        // one of templates
  properties: FieldDef[];         // no `module` fields
  vocabularies: { list: string /* list id */; cardinality: "one" | "many"; required?: boolean }[];
}
```

`pages.page_type_id` (NOT NULL), `pages.properties` (jsonb, validated
against the type), `pages.first_published_at` (set by the first Publish
live, never by the AI), `page_terms(page_id, list_id, item_id)` — draft
state of the page, part of the page snapshot. `site_defaults.default_page_type_id`
is the stored default for new pages (no code fallback).

Page types replace `templates.kind`: the AI reads "this module sits on
three News pages" from the page type (CLAUDE.md §1A).

## 6. Sources

```ts
PageQuery = {
  page_type?: string;             // page type slug
  terms?: string[];               // caelo:term/<listId>/<itemId>
  terms_mode?: "any" | "all";     // default any
  parent?: string;                // caelo:page/<id> — direct children only
  exclude_current?: boolean;      // default true
  order: "published_desc" | "published_asc" | "title_asc" | `prop_desc:${string}` | `prop_asc:${string}`;
  limit: number;                  // 1..50
}
QueryKnob = "page_type" | "terms" | "terms_mode" | "parent" | "exclude_current" | "order" | "limit"
SystemSourceName = "breadcrumbs" | "children" | "siblings" | "page_terms" | "term_pages"
```

A query matches pages that are published in the build being rendered
(preview: the draft view of pages whose status is `published`, plus the
rendering page itself excluded by default). When the `link-resolve`
composition point partitions pages into variants, a query only returns
pages in the rendering page's variant.

Every generated entry (query and the page-shaped system sources) exposes:
`title`, `link` (`caelo:page/<id>`), `published_at`, `updated_at`,
`summary` (SEO description), `image` (social image, media), `page_type`,
`props.<name>`, `terms.<vocabulary slug>` (iterable), `is_current`.
`page_terms` and term-shaped entries expose the vocabulary entry's values
(`name`, `slug`, …) plus `link` = its `landing_page` when set.

`system` sources: `breadcrumbs` (root → current via `parent_page_id`,
current page included), `children` / `siblings` of the current page
(published, title order; `siblings` includes the current page, marked
`is_current`, so a sub-navigation needs no special case), `page_terms`
(on a module field, `list` names the vocabulary as `caelo:list/<id>`; on
a source node, the vocabularies of the node's `term` fields; neither =
all of the page's terms), `term_pages` (published pages of the rendering
page's variant carrying any of the terms, title order, at most 50; the
terms come from the placement value's `terms` on a module field, from
the node's `term` field values on a source node).

Plugin sources replace the plugin manifest's `dataLists`: a plugin
declares `listSources: [{ name, label, node: NodeDef }]`; the host
resolves them per page before rendering, exactly where `dataLists` were
resolved, and passes them to `forPage` as `pluginSources` (entries
`{ id, values }`; until the SDK change lands, `pluginSourcesFromDataLists`
converts the `dataLists` answer, ids are positions). A section name no
module field declares but an installed plugin does (`{{#language_links}}`)
reads that plugin source too; module fields always win.

## 7. Module field kind `list`

Replaces `text-list` and `link-list` (`module-list` stays: it composes
modules, lists carry data).

```ts
{ name, label, kind: "list",
  listType: string;                       // list type slug
  bind?: "local" | "shared" | "source";   // default "local"
  list?: string;                          // shared: caelo:list/<id>; fixed for every placement when set
  source?: SourceDef;                     // bind: source
  min?: number; max?: number;
  default?: ListItem[] | string;          // local: items; shared: caelo:list/<id>
}
```

Value per placement (content instance value or chrome placement default):
`local` → `ListItem[]`; `shared` → `caelo:list/<id>` when the module did
not fix `list`; `source` → `Partial<PageQuery>` overrides within the
source's `editable` knobs. A shared field with neither `list` nor a value
renders the loud marker `list-unbound:<field>`.

Validation is split: the module field schema (`content.ts`) checks the
shape — the binding's parts fit together (`source` only with `bind:
"source"`, `list` only on shared fields or as a `page_terms` vocabulary,
a local default is entries, a shared default a list reference) — while
whether entries fit the named list type needs the type, which is stored
data: the module and content ops validate that with `validateListItems`
(and assign entry ids) on write. Rendering reports a type that is gone
as `list-type-missing:<slug>`; a `bind: "source"` field renders without
reading its type.

When the AI decides local vs shared (tool descriptions + skill carry it):
only this module, flat → local; needed in more than one place, navigation
of the site, edited by people without module context, or assigning pages
(vocabulary) → shared. `lists.promote_local` turns a local list into a
shared one and rebinds the field in one call.

Neither the HTML extractor (`ops/content/extract-module-lists.ts`, run by
`modules.create` / `modules.update` when no fields are passed) nor
moduleize (`ai/moduleize.ts`) ever mints a list type: types are
site-wide stored data whose writes need `content.structure`, the
extractor is a pure fallback and moduleize is a structured-output call
without tools. Both make repeated siblings ONE local list field of a
shipped type (moduleize by instruction, checked on its output; the
extractor by rule) — plain-text `<li>` (or 3+ same-class `<p>` / `<span>`) →
`texts`, link rows (3+ `<a>`, or `<li><a>`) → `links`, entries with one
level of sub-lists → `menu` — and leave entry ids to the module op.
A group no shipped type holds (cards of image + heading + text, entries
whose markup differs) keeps scalar fields; moduleize keeps a hinted
custom-type list field and takes its entries from the hint. The
authoring AI that wants such a collection editable creates the type
first (`upsert_list_types_many`) and authors the field, or makes the card
its own module and the section a `module-list`.

## 8. Template syntax

`packages/shared/src/template-engine.ts` keeps its Mustache-subset
grammar, the loud-raw invariant and raw (unescaped) substitution. List
sections are parsed with balanced matching, so a children name may repeat
inside itself.

| syntax | meaning |
|---|---|
| `{{#f}}…{{/f}}` | iterate list `f` (any binding); over a non-list value: conditional (unchanged) |
| `{{^f}}…{{/f}}` | inverted: renders when the list is empty or the value is absent/false |
| `{{#kids}}` inside an entry | iterate that entry's children (name from `children.name`) |
| `{{#items}}` inside a source node | iterate the generated entries |
| `{{>recurse}}` | inside a children section of a recursive type: render the current entry's children with the enclosing section's block (bounded by `max_depth`) |
| `{{x.y}}` | dot access into compound values (`link`, `media`, `date`, `icon`, `props`, `page`) |
| `{{>f}}` inside an entry | render the entry's `module` field |
| `{{#is_<node>}}` | true when the entry's node kind is `<node>` |
| `id node index depth first last` | system values (`index` 0-based, `depth` 1-based) |
| `is_current`, `is_ancestor` | from `current_from` and the page being rendered |
| `has_<children>`, `count_<children>` | per children / items list |
| `{{page.title}}`, `{{page.props.x}}`, `{{#page.terms.tags}}` | the page being rendered (any module) |

Lookup inside an entry: the entry's own keys first, then the enclosing
entries outwards, then the module's fields. A key found nowhere stays raw
and pushes `field-not-declared:<f>.<key>` (`<f>` = the module field the
outermost section iterates). A declared but empty entry field is empty,
never looked up further out.

Details the table leaves open:

- `items` is reserved: on a node without a source it is an empty list, so
  a block shared by mixed node kinds needs no `{{#is_<node>}}` guard.
- `is_current`: the entry's `current_from` link resolves to the rendering
  page (same page id, or the same resolved URL without query / fragment
  for literal hrefs). `is_ancestor`: some descendant entry is current or
  an ancestor, or the entry links a page above the rendering page in the
  page tree. Nodes without `current_from` (a column) are never current
  but can be ancestors.
- `{{>recurse}}` renders the innermost iterated entry's stored children
  with the block of the section that iterates it, so one block draws a
  tree of any depth; the depth is bounded by the stored data, which
  validation bounds by `max_depth` (≤ 8).
- `{{>f}}` for an entry's `module` field asks the caller's partial
  resolver for key `list:<moduleField>/<itemId>/<f>` with the ref; the
  nested renderer resolves it through its usual depth / cycle guards and
  attributes failures to `<moduleField>[<itemId>].<f>`.
- Media render as their reference (`caelo:media/<id>`); like page links,
  references resolve in the finished HTML through the page's link
  resolver. `{{f.formatted}}` uses `Intl.DateTimeFormat(siteLanguage,
  { dateStyle: "long", timeZone: "UTC" })`.
- Query and system entries expose `id`, `index`, `first`, `last`,
  `depth` (always 1) and `is_ancestor` besides the page keys.
- Values are data: every value the section pass pastes is wrapped in the
  engine's sentinels (#1053), so `{{…}}` inside content stays literal.

New markers: `list-unbound:<field>`, `list-missing:<listId>` (and
`list-missing:<listId>/item/<itemId>` for a term whose vocabulary entry is
gone), `list-type-missing:<slug>`, `list-source-unavailable:<name>
plugin=<slug>` (`plugin=unknown` when no installed plugin declares the
name), `list-malformed:<field>[<path>]`, and
`list-context-unavailable:<field>` / `…:page` for a list or `{{page.*}}`
rendered by a caller that passed the engine no list context (never
legitimate output). The template keeps the section raw in each case.

## 9. Translation: core enables, the plugin translates

Core has no locale concept and no "translatable" flag (epic #380). It
provides five neutral hooks:

1. **Addresses** (`packages/shared/src/lists/address.ts`): every stored
   value has a stable string address:
   `list/<listId>/item/<itemId>/<field>`,
   `instance/<contentInstanceId>/<field>/item/<itemId>/<itemField>`,
   `page/<pageId>/props/<field>`, `list_type/<typeId>/node/<node>/<field>`.
2. **Definition extensions**: a plugin manifest declares `listExt:
   { field?: ZodJSON, node?: ZodJSON }`; values live under
   `ext.<pluginSlug>` on field and node definitions. Core validates them
   against the active plugin's schema and stores them; it never reads
   them. With the plugin archived they stay as inert data.
3. **Composition point `list-resolve`**: before a build (and per preview)
   the host asks every plugin that answers it for an overlay per output
   variant: `{ [variant]: { values: Record<address, unknown>; hidden: address[] } }`.
   The resolver applies the overlay of the rendering page's variant
   (from `link-resolve`'s page variants). An overlay can replace values
   and hide entries; it cannot add, remove or reorder entries (enforced by
   the resolver: unknown addresses are dropped and reported as plugin
   errors).
4. **Domain events** with the chat branch: `list.items_changed`
   (`added | updated {fields, before} | moved | removed` per entry),
   `list_type.changed` (`fieldsAdded/fieldsRemoved/nodesRemoved`),
   `list.deleted`, `page.properties_changed`, `page.terms_changed`.
5. **Audit contributions**: a plugin names one of its operations as
   `auditFindingsOperation` (manifest field; shipped and runtime-installed
   plugins alike, no capability). Each Stage audit calls it once through
   the broker as a render (read-only) invocation on the main line — what
   the staged build was rendered from:

   ```ts
   // args (PluginAuditFindingsArgs): the published pages of the staged build
   { pages: { pageId: string; path: string }[] }
   // returns (pluginAuditFindings, at most 499)
   { findings: {
       rule: string;                         // ^[a-z][a-z0-9-]{0,59}$, e.g. "translation-missing"
       severity: "error" | "warning" | "info";
       pageId?: string;                      // one of the pages passed in; absent = site-wide
       message: string;                      // ≤ 1000, "Label: what is wrong — what to do"
       fix?: { tool: string; hint: string }; // the AI tool that fixes it, ≤ 80 / ≤ 500
     }[] }
   ```

   Core files each finding as `plugin.<slug>/<rule>` in the same report as
   its own checks (`quality/checks/plugin-findings.ts`); an `error` blocks
   Publish live until fixed or accepted by the Owner. A failing call, a
   malformed answer or a page outside the staged build fails the audit
   loudly. Details: `docs/quality-checks.md` → *Plugin contributions*.

`international-site` builds on these: the `translate` attribute, its
branch-aware storage, the change handling table (added → `missing`,
source changed → `needs_update`, moved → nothing, removed → `orphaned`
and garbage-collected after the removal is live, link target without a
variant → entry hidden + finding, query nodes scoped by variant), its AI
tools and the "Languages" tab in the list editor. See the plugin's README.

## 10. Rendering, preview, builds

- `packages/shared/src/lists/resolve.ts` exports
  `createListRenderContext(data, { dormantPluginSources })` and
  `resolveListField(field, value, pageCtx, holder)`.
  `ctx.forPage(pageId | null, { linkResolver, pluginSources })` returns
  the `ListPageContext` the template engine takes as
  `RenderTemplateInput.lists` (with `listHolder: { contentInstanceId }`
  naming the stored instance a local list belongs to); the composer takes
  it as `ComposeInput.lists` and threads it to every placed, nested and
  chrome module.
  The context is built once per preview / per build from batch-loaded
  data (`ListRenderData`: list types, lists, page index for queries,
  media index, vocabulary index, plugin sources per page, overlays per
  variant) and cut per rendering page (`ctx.forPage(pageId)`), the same
  way `SiteLinkIndex` works. Everything after loading is pure and sync.
- Preview composer and static generator build the context identically;
  the preview loads the draft overlay of lists, list types, pages,
  properties and terms.
- Render dependencies: the per-page context records `lists` (ids),
  `listTypes` (slugs), `queries` (normalised filters) and `pageTree`,
  lazily — only what the render reached. The generator writes
  `render-deps.json` (`lists/render-deps.ts`) into the build directory
  and next to the target's builds (`<outDir>/render-deps.json`, merged
  across incremental builds):

  ```json
  {
    "version": 1,
    "pages": { "<pageId>": { "lists": [], "listTypes": [], "queries": [{ "pageType": "news", "terms": [], "parent": null }], "pageTree": false } },
    "index": { "<pageId>": { "pageType": "news", "terms": [], "parent": null, "title": "…", "inBuild": true } }
  }
  ```

  An incremental build (`deploy.trigger` with `changedPageIds`,
  `changedListIds`, `changedListTypeIds`; the redeploy orchestrator fills
  them from `audit_events`) adds every page whose deps intersect the
  change: a changed list or type, a page whose filter attributes before
  (the file's `index`) or after match a recorded query, and every
  page-tree reader when a changed page's title, parent or build
  membership changed. Without a deps file the build renders every page.
  A list-domain write whose audit row names no entity, and every page
  type write, rebuild every page.
- Limits: depth ≤ 8, ≤ 500 entries per list, ≤ 50 per query, embedded
  module recursion limited by the nested renderer's existing depth guard.
- Interaction: modules use the interaction kit (`data-caelo-ui`, e.g.
  `mobile-nav` with the markup in `INTERACTION_MARKUP_CONTRACT`); there
  is no built-in menu renderer.
- Overlays: refused overlay entries (unknown address, a structural
  `module` / `term` value, a value failing its field) are collected on
  the context (`overlayIssues`); the generator logs them, the plugin's
  error channel takes them once the `list-resolve` point is wired.

## 11. Draft, snapshots, integrity

List types, lists and page types are entities with draft overlay,
snapshot, `version` for optimistic writes and entity locks, like content
instances. Properties and terms are part of the page snapshot. Reference
integrity (#724, `links/reference-integrity.ts` + `reference-lists.ts`)
follows lists the way they render — a module's `list` field renders its
shared list (and that list type's source defaults) on the module's pages,
an entry's `module` field renders that module there, a vocabulary renders
on the pages carrying its terms — and checks there: `caelo:list/<id>`
(field `list`, defaults, placement values, `page_terms` vocabularies →
`references/missing-list`), `caelo:term/<listId>/<itemId>` (page terms,
query `terms` in entries, list type source defaults and `source` field
values, `term` field values in entries and page properties →
`references/missing-term`), embedded modules (`references/missing-module`)
and page / media references inside shared and local entries and page
properties. A break blocks Stage and Publish live with a concrete fix
(`patch_list_items_many`, `update_pages_many`, `set_page_module_content`,
`edit_module`, `upsert_list_types_many`). A list nothing renders ships
nowhere and is not reported. A list that is still bound cannot be deleted
(the error names the modules); the integrity check catches what a race
between branches lets through. In a migration chat a list write keeps a
link to a page the import run will still build literal and records it
against the list (`import_run_links`, entity kind `list`);
`imports.resolve_links` rewrites the list once the page exists. The
structure check reports two modules keeping the same links as their own
copies (`structure/duplicate-navigation`, see `docs/quality-checks.md`). All writes are routine (no §11.A gate).
Writing list or page types needs `content.structure`, granted by default
to every role that holds `content.write`.

## 12. Query API operations and AI tools

| op | tool | notes |
|---|---|---|
| `list_types.list` | `list_list_types` | purpose, role, nodes (compact: fields, children, sources), list count |
| `list_types.get` | `list_list_types` with `slug` | + the shared lists and local lists of the type |
| `list_types.upsert_many` | `upsert_list_types_many` | `dropValues` |
| `list_types.delete_many` | `delete_list_types_many` | refused while lists use it |
| `lists.list` | `list_lists` | filter `type`, `role`, `query`; usage: modules (`module.field`), placements, sample pages, vocabulary use, `updatedAt` |
| `lists.get` | `get_list` | draft view, humanised links, entry tree with ids |
| `lists.upsert_many` | `upsert_lists_many` | create or replace; returns `caelo:list/<id>` for binding |
| `lists.patch_items_many` | `patch_list_items_many` | `add {parentId?, position?, item}`, `update {itemId, values}`, `move {itemId, parentId?, position}`, `remove {itemId}`; always loaded (core tool) |
| `lists.delete_many` | `delete_lists_many` | refused while bound |
| `lists.promote_local` | `promote_local_list` | module field → shared list + rebind |
| `lists.preview_source` | `preview_list_source` | what a query / system / plugin source returns for a page (below) |
| `page_types.list` | `list_page_types` | templates, properties, vocabularies, page count |
| `page_types.get` | `list_page_types` with `slug` | + sample pages |
| `page_types.upsert_many` | `upsert_page_types_many` | `dropValues` |
| `page_types.delete_many` | `delete_page_types_many` | refused while pages use it and for the site default; a tool because the AI creates page types (§11 parity) |
| `pages.update_many` (extended) | `update_pages_many` | `pageType`, `properties`, `terms` |
| `pages.build_page` (extended) | `build_page` | `page.pageType`, `page.properties`, `page.terms` (create mode) |
| `templates.create` / `templates.propose_update` | `create_template` / `propose_update_template` | `pageType` (replaces `templates.kind`) |

The tools take the op's own input schema (`ai/tools/_list-tool-kit.ts`),
so the JSON Schema a provider sees is generated from the shared Zod
definitions; the recursive entry tree comes out as `$defs` + `$ref`
(docs/internal/google-models.md). Module authoring tools embed list entries
inside the `fields` schema, where a root-relative `$ref` cannot resolve, so
they declare three fixed levels instead (enough for `menu`). Op error hints
that name ops are rewritten to tool names (`toolNamesIn`). Every list tool
repeats the alias (menus, navigation, footer links, categories and tags are
shared lists; a list only one module shows stays local); the module tools
carry the list field contract (template keys, the three bindings and their
values).

`lists.preview_source` input, exactly one of:

- `source` (a `SourceDef`) with optional `value` (the placement's overrides:
  query knobs within `editable`, or `{terms}` for `term_pages`) and
  `vocabulary` (`caelo:list/<id>` for `page_terms`);
- `list` (slug) + `itemId`: a source node stored in a shared list, with its
  saved `query`;
- `moduleId` + `field` (+ `contentInstanceId`): a module's `bind: "source"`
  field with that placement's value.

`pageId` names the rendering page (breadcrumbs, children, siblings,
page_terms need one; a query leaves it out by default). The answer is
`{ source, count, entries }`, each entry `{id, title?, name?, label?, slug?,
link?, published_at?, updated_at?, page_type?, summary?, is_current?}` with
links as paths. It runs the render's own resolver over
`loadListRenderData` in the caller's draft view; plugin sources are asked
per page like in the preview.

## 13. Admin UI

One area, *Content → Menus & lists* (`/content/lists`): lists grouped by
type, tree editor generated from node definitions (drag and drop, page
and media pickers, query preview, "Used in"), tab **Structure** (edit this
list's type; shows how many lists share it) and tab **Types** (all list
types and page types). Without `content.structure` both tabs are
read-only. Page settings carry page type, properties and terms. Rendered
entries carry `data-caelo-list-item` so click-to-chat attaches a chip for
the list entry, not the module. The engine stamps it on the root element
of each rendered stored entry — the first opening tag, when the entry's
markup starts with one (an entry that starts with text has no root and
stays unstamped), the same way the composer stamps `data-caelo-module-id`
on a module root:

- shared list entry: `<listId>/<itemId>`;
- local list entry of a stored placement: `instance/<contentInstanceId>/<field>/<itemId>`;
- local list entry rendered from a field default (site chrome):
  `local/<field>/<itemId>` (the module root's `data-caelo-module-id`
  names the module).

Generated entries (queries, system and plugin sources) carry none — they
are no stored entry. The Live Edit preview's in-place editing marks a
local entry's text values as `<field>.<itemId>.<key>` (a link target
`….<key>.href`), and `page_module_content.patch_fields` takes
`{ field, item, key, part? }`.
