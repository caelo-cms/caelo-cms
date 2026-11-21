# Plugin configuration

Epic #1644, R6 (issue #1645). A plugin declares its settings as a schema; core stores them, validates every write, shows them to the operator as a generated form and to the AI as tools, and decides when a change takes effect. No plugin writes its own settings table or settings page.

## Declaring a schema

```ts
import { definePlugin } from "@caelo-cms/plugin-sdk";

export default definePlugin({
  slug: "site-search",
  // …
  config: {
    results_page: {
      type: "pageRef",
      label: "Results page",
      description: "The page that shows the results.",
      effect: "pages",
      default: null,
    },
    ranking: {
      type: "group",
      label: "Ranking",
      description: "How results are ordered.",
      fields: {
        typos: { type: "bool", label: "Tolerate typos", description: "…", effect: "query", default: true },
        page_type_weights: {
          type: "map", keys: "pageType", label: "Weight per page type", description: "…",
          effect: "query",
          value: { type: "number", label: "Weight", description: "1 = normal.", effect: "query", min: 0, max: 5, default: 1 },
          default: {},
        },
      },
    },
    popular_suggestions: {
      type: "bool", label: "Suggest what visitors search for", description: "…",
      effect: "none", gate: "approval", default: false,
    },
  },
  entityConfig: {
    page: { excluded: { type: "bool", label: "Not in the site search", description: "…", effect: "pages", default: false } },
    module: { home_page: { type: "pageRef", label: "Home page", description: "…", effect: "pages", default: null } },
  },
});
```

Leaves: `bool`, `int`, `number`, `enum`, `string`, `pageRef`, `listRef` (a list of a given list type, often one the plugin ships), `catalogModel` (an embedding model of the core catalog, `packages/shared/src/embedding-models.ts`), `map` (keyed by page type, language or module). `group` nests. At most 120 leaves (`MAX_CONFIG_LEAVES`).

Every leaf carries:

- `label` and `description` in the operator's terms. The form shows them; the AI reads them in `get_plugin_config`. Say what the setting does, not how it is implemented (CLAUDE.md §1A).
- `effect`: what changes when the value does. `query` means the next search after Publish live. `pages` or `rebuild` means the plugin re-reads every page at the next Stage. `none` means nothing visitors see.
- `gate` (`routine` by default). `approval` makes a change a §11.A proposal: the AI calls `propose_plugin_config`, and the Owner approves it in the chat card or at `/settings/plugin-config`. Use it for money and privacy (a cost cap, starting to count visitors' queries).
- `scope` (`release` by default): a change waits for Stage and Publish live like content. `immediate` applies at once and is allowed only for `effect: "none"`.

`checkConfig` (SDK) refuses a schema that breaks these rules, as manifest validation errors.

## Storage

Three host-owned rows per plugin, in its private schema (`caelo_config`):

| Row | Holds | Written by |
|---|---|---|
| `release` | the `release` leaves | branch-aware like any plugin row: a chat writes its draft, Stage merges, Publish live ships (`branch-aware-plugin-storage.md`) |
| `immediate` | the `immediate` leaves | main, at once |
| `approved` | values an approved proposal set | `plugin_config.execute_proposal` on main |

Row ids are deterministic (uuid v5 of slug and scope). Entity settings live in `caelo_entity_config`, one row per entity, branch-aware the same way. Activation seeds the defaults and migrates what is stored when the schema changes: a new field gets its default, a dropped one goes, an invalid one is reset and reported.

## Reading

`ctx.config.get()` returns the merged value as the call's branch sees it (a chat sees its draft, an observer and a batch see main). `ctx.config.entity(kind, id)`, `entities(kind, ids)` (a Map) and `configured(kind)` read the per-entity settings; an unset field reads as its default. In the sandbox, `config.entities` travels as entry pairs and comes back as a Map. `entities` takes any number of ids: the host reads them in bounded chunks (1000 per sandbox call, 5000 per host operation).

A page-output observer gets every page again after a change to the plugin's version, its `release` and `approved` settings or its module settings (the observer digest), and one page again after a change to that page's settings (`plugin-page-output.md`).

## The AI's tools and the operator's form

- `get_plugin_config`: every field with its value, allowed values, effect and gate, plus the entity fields.
- `preview_plugin_config`: a dry run of a patch, plus the plugin's own report when it declares `configPreviewOperation`.
- `update_plugin_config`: a merge patch. It lands on the chat's draft, and undo works. A plugin's configuration writes run one at a time (a transaction lock per plugin): each reads the stored rows, merges and writes whole rows back, so two saves of different fields at once both stay.
- `propose_plugin_config`: a patch containing an `approval` field, applied after the Owner's click.
- `set_plugin_entity_config_many`: per-entity values. `null` returns a field to its default.

`/settings/plugin-config/<slug>` renders the same schema as a form (`apps/admin/src/lib/components/plugin-config/`). Saving applies routine fields and queues approval fields. `/settings/plugin-config` lists the pending proposals.

## Ops

`plugin_config.get`, `.update`, `.preview`, `.get_entities`, `.set_entities` (human, AI, plugin as allowed per op), `.seed` (system), and the §11.A trio `.propose_update` / `.execute_proposal` (approver needs `settings.write`) / `.reject_proposal`, with `.list_pending`. Source: `packages/plugin-host/src/plugin-config.ts`, `packages/admin-core/src/ops/plugin_config_pending.ts`.
