---
slug: plugins-tier-2
template: doc-page
locale: en
status: published
seo:
  title: Tier 2 plugins — Caelo CMS
  description: AI-authored, sandboxed in Deno, locked SDK surface. Per-plugin RLS scoping. Owner approves each plugin per active transition.
---

# Tier 2 plugins

The sandboxed half of the [plugin host](/plugins-build). This page covers the constraints + safety surfaces — read [Build a plugin](/plugins-build) first if you haven't.

## Why Tier 2 exists

Two reasons:

1. **AI-authorability.** The chat can draft an entire plugin in one turn. Source goes to `plugins.source_code` in the database, not to disk. No PR, no human reviewer required for the *technical* layer (the validator is the technical reviewer); Owner approval gates the *trust* layer (you decide whether the plugin's behaviour is what you want).
2. **Defense-in-depth via runtime isolation.** Even if the validator misses something, the Deno subprocess can't read files, can't open sockets, can't reach env vars, can't reach the cms_admin database. Postgres RLS forces per-plugin scoping at the database layer; even within `cms_public`, plugin A cannot see plugin B's tables.

## What runs where

```
                 (Bun host process)
                       ↓
            Plugin host detects request
                       ↓
            Spawn fresh Deno subprocess
                       ↓
   ┌───────────────────────────────────────┐
   │ Deno subprocess                       │
   │   --no-read --no-write --no-net       │
   │   --no-env --no-prompt --no-npm       │
   │   --no-remote                         │
   │                                       │
   │ Plugin code runs here.                │
   │ ctx.query.* → JSON-RPC over stdio     │
   │ ctx.api.*   → JSON-RPC over stdio     │
   └───────────────────────────────────────┘
                       ↑
            Bun host bridges stdio
            to the cms_public connection
            with caelo.plugin_id session var set
```

## Capabilities the plugin gets

```ts
ctx.query.insert(table, data) → { id }
ctx.query.list(table, filter) → row[]
ctx.query.update(table, id, patch)
ctx.query.delete(table, id)

ctx.api.list(table, filter) → row[]   // visitor-side public read
ctx.api.get(table, id) → row | null

ctx.theme.tokens                       // read-only CSS vars
ctx.theme.locale

ctx.visitor.id                         // visitor cookie id
ctx.visitor.publicUserId               // when logged in via auth plugin
ctx.visitor.locale
ctx.visitor.sessionToken
ctx.visitor.setSession({...})          // mutator (auth plugin uses)

ctx.captcha.requireProof(token) → boolean
```

That's it. **No** `ctx.cms`, `ctx.ai`, `ctx.snapshots`, `ctx.tools`, `ctx.email`, `ctx.workers`. Manifests declaring `requestedCapabilities` are rejected by the validator.

## Per-plugin RLS scoping

Every Tier 2 plugin's tables live under its slug-prefixed schema:

```
cms_public.plugin_<slug>.<table>
```

Each table carries an RLS policy that matches `current_setting('caelo.plugin_id')`. The Bun host sets `SET LOCAL caelo.plugin_id = '<plugin-uuid>'` per transaction — so even if the plugin's code is misbehaved (or the validator missed a hole), Postgres at the database layer prevents reads of other plugins' data.

You can verify this by attempting a cross-plugin read from inside a plugin's `ctx.query` call — the Validator + RLS + the schema-validator triple-stack will fail closed.

## Validator forbidden patterns

The validator (`packages/plugin-sandbox/src/validate.ts`, oxc-parser-based) walks the compiled JS module tree before the plugin reaches the sandbox. It rejects:

| Forbidden pattern | Why | What to use instead |
|---|---|---|
| `import x from 'node:fs'` | Filesystem access | (no equivalent — plugins don't need files) |
| `fetch(...)` / `XMLHttpRequest` | Network egress | (none — plugins are server-internal) |
| `Deno.readFile`, `Deno.env.get`, etc. | Bypass sandbox flags | (none) |
| Dynamic `import()` | Runtime code injection | Static `import` from `@caelo-cms/plugin-sdk` |
| Template literals matching SQL keywords | Raw SQL | `ctx.query.insert/list/update/delete` |
| `eval`, `Function`, `new Function` | Runtime code injection | (none) |
| Top-level `globalThis` writes | Escape vector | Module-scoped consts only |

Validation failures return structured errors the AI can auto-fix and re-submit:

```ts
{
  kind: 'forbidden-pattern',
  nodeType: 'CallExpression',
  snippet: "fetch('https://evil.com')",
  location: { line: 12, column: 17 },
  hint: "use ctx.api.list() instead of fetch()"
}
```

## Schema rules

Every table in `manifest.schema`:

- Must declare `id: 'uuid'` (primary key)
- If it declares `page_id: 'string'`, **must also declare `locale: 'string'`** (per-page data is locale-aware by default; visitor sees the right locale's data via the `locale` filter)
- Cannot redeclare `caelo_plugin_id` (the host adds it for the RLS policy)

The validator runs schema rules before the SQL emitter; bad shapes fail at submit time with a clear error.

## What "AI authors a Tier 2 plugin" looks like end-to-end

1. You ask the chat: "draft a Tier 2 plugin called `event-rsvp`..."
2. AI calls `submit_plugin({slug, source, manifest})`. Validator runs synchronously.
3. **Pass:** `plugins` row inserted with `status='awaiting_activation'`. AI tells you "click Approve at /security/plugins/event-rsvp" and the chat surfaces the validation summary.
4. **Fail:** `status='draft'` + structured errors in `validation_errors`. AI fixes + re-submits in the same turn (loop until pass).
5. You navigate to `/security/plugins/event-rsvp`. You see: source diff (the full text), declared schema, declared operations, declared component tag, validation summary.
6. You click **Approve**. The host opens a transaction, creates `cms_public.plugin_event_rsvp`, applies the schema, registers the plugin's operations, mounts the Web Component placeholder. Status flips to `active`.
7. The plugin is live. Visitors can interact via the API gateway; admin sees data via `ctx.api.*` calls (the AI can summarise via `summarize-plugin-data` skill).

## Disabling a plugin

`/security/plugins/<slug>` → "Disable" sets `status='disabled'`. The host stops dispatching to it. **The plugin's tables stay** — data preservation. Re-enable flips status back; no schema changes needed.

To completely uninstall + drop the plugin's schema, use `plugins.uninstall` (lands as a follow-up; v1 keeps tables on disable for safety).

## When NOT to use Tier 2

- You need cross-`cms_admin` writes → Tier 1
- You need to register a chat-runner AI tool the AI can dispatch → Tier 1
- You need a background worker (cron-style) → Tier 1
- You need to send emails → Tier 1
- You need to call the AI provider from within the plugin → Tier 1

For those cases, ship Tier 1 via PR per [Build a plugin](/plugins-build).

## Tier-boundary one-way door

A Tier 2 row's `tier` column is immutable after insert. To "graduate" a community Tier 2 plugin into core: a human contributor reads the source, refactors as needed, audits, signs the manifest, lands it via PR in `packages/plugins/<slug>/`, bumps the Caelo version. There's no UI shortcut by design.

## Next

- [Build a plugin →](/plugins-build) (the Tier 1 path is here)
- [Architecture →](/architecture)
- The [`@caelo-cms/plugin-sandbox` source](https://github.com/caelo-cms/caelo-cms/tree/main/packages/plugin-sandbox)
