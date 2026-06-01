# Module `type` and composition constraints

Issue #106 (v0.12.3) added a stable `modules.type` column and reworked how a
module field whitelists the modules that may fill a nested slot. This is the
reference for both.

## `type` vs `slug`

Every module row carries two identifiers:

| Column | Meaning | Example | Unique? |
|---|---|---|---|
| `slug` | The unique **row identity**. AI-minted modules append a uniqueness suffix. | `button-mpqxq3ch` | Yes (per branch) |
| `type` | The stable **reusable class** — what the module *is*. Many rows can share one. | `button` | No |

`type` is `NOT NULL`. It is derived from the module's display name at the single
`modules.create` chokepoint via `deriveModuleType(displayName)` (in
`@caelo-cms/shared`): the slugified base **without** the uniqueness suffix. The
slug is composed as `deriveModuleType(name) + "-" + suffix`, so `type` is always
a prefix of `slug` and the two cannot drift.

The AI may author `type` explicitly on `add_module_to_page` / `edit_module` when
it matters — e.g. minting a second button variant as `type: "button"` so it
satisfies a CTA's `allowedModuleTypes` whitelist. When omitted, the op derives
it.

## Composition: `allowedModuleTypes`

A `module` or `module-list` field can constrain which modules may be nested in
its slot with an **`allowedModuleTypes`** whitelist — an array of stable `type`s
(NOT slugs):

```jsonc
{ "name": "cta_button", "kind": "module", "label": "Button",
  "allowedModuleTypes": ["button"] }
```

When a `content_instances` value binds a module into that slot, the validator
(`packages/admin-core/src/ops/content/content-instances.ts`) accepts the
reference iff the **referenced module's `type`** is in the whitelist. It matches
`type`, **never** `slug`. On a mismatch the error is AI-actionable: it names the
candidate set and the next step (reuse a module whose `type` is allowed, or widen
the field's `allowedModuleTypes` via `edit_module` on the parent module).

### Why types, not slugs

The field used to whitelist `allowedModuleSlugs` and match against `modules.slug`.
That could *never* match an AI-minted module: the AI authors `["button"]` but the
module it creates is `button-mpqxq3ch`, so the bind always failed and the AI was
left handing an editor-UI chore to the operator (the bug behind issue #106).
Matching a stable `type` fixes this — `button-mpqxq3ch` has `type: "button"`,
which is in the list.

## Migration `0103` and backfill semantics

`0103_p_v0_12_3_module_type_stable_constraints.sql` runs in one transaction,
idempotently:

1. `ADD COLUMN type text` (nullable), backfill `type = slug` for existing rows,
   then `SET NOT NULL`.
2. Rewrite every stored `modules.fields` element that carries the old
   `allowedModuleSlugs` key, renaming it to `allowedModuleTypes` (value
   unchanged); elements without the key are untouched.

Because `type` is backfilled to the old `slug`, **legacy exact-slug allowlists
keep working** — a stored `["legacy-exact"]` still matches a module whose
`slug == type == legacy-exact`. AI-minted suffixed modules start working too.

## Where the AI sees this

- The `## Modules` system-prompt block shows each module's `type` and `slug`
  distinctly, and renders every `module`/`module-list` field's
  `allowedModuleTypes` in full (never truncated).
- The `## Module model` primer states the nested-ref contract: a nested value is
  `{ moduleId, contentInstanceId }`, the referenced module's `type` must be in
  the field's `allowedModuleTypes`, and the AI should reuse an existing module of
  an allowed type rather than minting a near-duplicate.
