# Phase 11 — Plugin SDK + Deno sandbox + oxc-parser validator

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P1 (Query API).
**Unblocks:** P12, P13.

## Goal (from master plan)
Plugin SDK (`definePlugin`, `defineComponent`, injected `query`/`api`/`theme`). oxc-parser-based static validator with forbidden-pattern rules (no `fetch`, no `Deno.*` except allowed surface, no dynamic import, no raw SQL). Deno subprocess runner with only the SDK injected — no filesystem, no network. **Web Component frontends mount inside Shadow DOM** (requirements §14.5) so plugin CSS can never leak into the host page and vice versa. **Plugin schemas supporting per-page data must declare a `locale` field** (requirements §14.2) — the Validator rejects schemas missing it when `page_id` is present. Schema declaration drives `cms_public` table provisioning per plugin. Plugin registry with validate → activate lifecycle; **activation always requires explicit human confirmation — AI actors can submit a plugin for validation but cannot activate it** (requirements §17.4). Deliverable: a hello-world plugin round-trips through validator + sandbox + produces a Shadow-DOM Web Component and static render; an AI-submitted plugin stays in `awaiting_activation` until a human Owner confirms.

## End-to-end verification
Hello-world plugin: validator catches a forbidden pattern; human Owner activates it; Web Component renders inside Shadow DOM (host page CSS leak test passes); static render both work. **AI actor submits plugin → status=`awaiting_activation`; AI cannot activate; human Owner activates via admin UI.** Plugin schema missing `locale` on a `page_id`-scoped table is rejected at validation.

## To be detailed before execution
- SDK surface: `definePlugin({ schema, operations, component, staticRender })`, injected `{ query, api, theme }` — strict Zod-typed. `theme` includes site theme tokens + current page locale.
- **`defineComponent`** attaches Shadow DOM in open mode by default; closed mode configurable per plugin. Theme tokens injected as CSS custom properties on the shadow root.
- oxc-parser version (verify current) + custom rule walker: forbidden nodes (ImportDeclaration of anything outside allowed, CallExpression of `fetch` / `Deno.readFile` / etc., dynamic import, template literal SQL).
- **Schema validation rule:** any plugin table referencing `page_id` must also declare `locale` (requirements §14.2). Validator fails closed.
- Deno subprocess flags: `--no-read`, `--no-write`, `--no-net`, `--no-env`, inject SDK via `--allow-import` whitelist.
- Schema → migration: plugin `schema` declaration generates `cms_public` tables under the plugin's namespace.
- Plugin registry in `cms_admin`: registration state, validation errors, activation status (`draft`, `validated`, `awaiting_activation`, `active`, `disabled`).
- **Activation gate:** `plugins.activate` Query API op rejects any AI actor; human Owner required. Audit log records who activated.
- Adversarial test suite: plugins that try `fetch`, direct file access, dynamic import, SQL injection, host-page CSS leak, and AI-actor self-activation — all must be rejected.
