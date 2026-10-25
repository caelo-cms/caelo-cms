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
| `icon` | icon name (`[a-z0-9-]+`) | `{{f}}` = name, `{{f.svg}}` (inline SVG from the theme icon set, else marker) | |
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

`system` sources: `breadcrumbs` (root → current via `parent_page_id`),
`children` / `siblings` of the current page (published, title order),
`page_terms` (field `list` names the vocabulary), `term_pages` (pages
carrying a given term; the term comes from the field value).

Plugin sources replace the plugin manifest's `dataLists`: a plugin
declares `listSources: [{ name, label, node: NodeDef }]`; the host
resolves them per page before rendering, exactly where `dataLists` were
resolved.

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

When the AI decides local vs shared (tool descriptions + skill carry it):
only this module, flat → local; needed in more than one place, navigation
of the site, edited by people without module context, or assigning pages
(vocabulary) → shared. `lists.promote_local` turns a local list into a
shared one and rebinds the field in one call.

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
and pushes `field-not-declared:<f>.<key>`.

New markers: `list-unbound:<field>`, `list-missing:<listId>`,
`list-type-missing:<slug>`, `list-source-unavailable:<name> plugin=<slug>`,
`list-malformed:<field>[<path>]`, `icon-missing:<name>`.

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
5. **Audit contributions**: a plugin may contribute Stage-audit findings
   through the existing plugin findings path.

`international-site` builds on these: the `translate` attribute, its
branch-aware storage, the change handling table (added → `missing`,
source changed → `needs_update`, moved → nothing, removed → `orphaned`
and garbage-collected after the removal is live, link target without a
variant → entry hidden + finding, query nodes scoped by variant), its AI
tools and the "Languages" tab in the list editor. See the plugin's README.

## 10. Rendering, preview, builds

- `packages/shared/src/lists/resolve.ts` exports
  `createListRenderContext(input)` and `resolveListField(field, value, ctx)`.
  The context is built once per preview / per build from batch-loaded
  data (`ListRenderData`: list types, lists, page index for queries,
  media index, vocabulary index, plugin sources per page, overlays per
  variant) and cut per rendering page (`ctx.forPage(pageId)`), the same
  way `SiteLinkIndex` works. Everything after loading is pure and sync.
- Preview composer and static generator build the context identically;
  the preview loads the draft overlay of lists, list types, pages,
  properties and terms.
- Render dependencies: the per-page context records `lists` (ids),
  `listTypes` (slugs) and `queries` (normalised filters). The generator
  writes them to the build manifest (`render-deps.json`). An incremental
  build adds every page whose deps intersect the change: a changed list
  or type, or a page that entered, left or changed inside a query's
  filter.
- Limits: depth ≤ 8, ≤ 500 entries per list, ≤ 50 per query, embedded
  module recursion limited by the nested renderer's existing depth guard.
- Interaction: modules use the interaction kit
  (`data-caelo-ui="disclosure" | "nav-toggle"`); there is no built-in
  menu renderer.

## 11. Draft, snapshots, integrity

List types, lists and page types are entities with draft overlay,
snapshot, `version` for optimistic writes and entity locks, like content
instances. Properties and terms are part of the page snapshot. Reference
integrity (#724) covers `caelo:list/<id>` (module fields, placements),
`caelo:term/<listId>/<itemId>` (pages, queries, term fields) and page /
media references inside entries; a break blocks Stage and Publish live
with a concrete fix. A list that is still bound cannot be deleted (the
error names the modules). All writes are routine (no §11.A gate).
Writing list or page types needs `content.structure`, granted by default
to every role that holds `content.write`.

## 12. Query API operations and AI tools

| op | tool | notes |
|---|---|---|
| `list_types.list` | `list_list_types` | purpose, role, nodes, list count |
| `list_types.get` | — | draft view |
| `list_types.upsert_many` | `upsert_list_types_many` | `dropValues` |
| `list_types.delete_many` | `delete_list_types_many` | refused while lists use it |
| `lists.list` | `list_lists` | filter `type`, `role`, `query`; usage: modules, placements, sample pages, `updatedAt` |
| `lists.get` | `get_list` | draft view, humanised links |
| `lists.upsert_many` | `upsert_lists_many` | create or replace |
| `lists.patch_items_many` | `patch_list_items_many` | `add {parentId?, position?, item}`, `update {itemId, values}`, `move {itemId, parentId?, position}`, `remove {itemId}` |
| `lists.delete_many` | `delete_lists_many` | refused while bound |
| `lists.promote_local` | `promote_local_list` | module field → shared list + rebind |
| `lists.preview_source` | `preview_list_source` | what a query / system source returns for a page |
| `page_types.list` / `get` / `upsert_many` / `delete_many` | `list_page_types`, `upsert_page_types_many` | |
| `pages.update_many` (extended) | `update_pages_many` | `pageType`, `properties`, `terms` |

## 13. Admin UI

One area, *Content → Menus & lists* (`/content/lists`): lists grouped by
type, tree editor generated from node definitions (drag and drop, page
and media pickers, query preview, "Used in"), tab **Structure** (edit this
list's type; shows how many lists share it) and tab **Types** (all list
types and page types). Without `content.structure` both tabs are
read-only. Page settings carry page type, properties and terms. Rendered
entries carry `data-caelo-list-item="<listId>/<itemId>"` so click-to-chat
attaches a chip for the list entry, not the module.
