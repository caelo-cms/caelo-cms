---
slug: plugins-build
template: doc-page
locale: en
status: published
seo:
  title: Build a plugin — Caelo CMS
  description: Two-tier plugin host. Tier 1 ships with core (signed, in-process). Tier 2 is AI-authored at runtime (Deno-sandboxed). Same SDK shape; runtime masks capabilities.
---

# Build a plugin

Caelo's plugin host has **two tiers** that share the SDK shape but differ in trust + runtime + capability surface. Pick the tier first; the rest follows.

## Tier 1 — Core plugins (in-process, signed)

**You're shipping code into the canonical Caelo release.** Tier 1 plugins live under `packages/plugins/<slug>/` in the source repo, are audited, signed with the Caelo Ed25519 key, and run in-process in the Bun host with the full SDK — cross-`cms_admin` writes, snapshot emission, AI provider access, chat-runner tool registration, background workers.

Examples shipped today: translation, forms, comments, newsletter, ratings, auth.

**Who writes Tier 1:** humans only. AI cannot edit Tier 1 source — that's audited code shipped with releases. AI can *propose* a Tier 1 PR by drafting it in chat and asking you to land it.

**How to ship one:**

1. Open an issue in [`caelo-cms/caelo-cms`](https://github.com/caelo-cms/caelo-cms/issues/new?template=plugin.yml) describing the plugin's purpose. Tier 1 surface is intentionally small; we'll discuss whether it belongs in core or as a Tier 2.
2. Scaffold under `packages/plugins/<your-slug>/`:
   - `manifest.json` — slug, version, tier=1, `requestedCapabilities` array (only the capabilities you need)
   - `src/index.ts` — `export default definePlugin({...spec})`
   - `migrations/0001_init.sql` — `CREATE TABLE` in `cms_public.plugin_<slug>.*`
3. Sign the manifest: `bun run plugins:sign` (uses the dev key for testing; production releases use the canonical key)
4. Open the PR; the reviewer checklist is in `CONTRIBUTING.md`

**Tier 1 declares capabilities up-front:**

```json
{
  "slug": "translation",
  "version": "1.0.0",
  "tier": 1,
  "requestedCapabilities": [
    "cms_admin", "ai_provider", "snapshots",
    "chat_runner_tools", "background_workers"
  ],
  "tools": [
    { "name": "translate_page", "description": "..." }
  ],
  "workers": [
    { "name": "job_runner", "cron": "*/30 * * * * *" }
  ]
}
```

The host only constructs the requested handles in your `ctx`; capabilities you didn't ask for stay absent. The validator flags an import you didn't declare.

## Tier 2 — Sandboxed plugins (AI-authored or Owner-installed)

**You're adding behaviour to YOUR install** without touching core. Tier 2 plugins are usually AI-authored — you ask the chat to draft one, the validator runs, the result lands in `/security/plugins` for Owner approval. Source is stored in `plugins.source_code` in the database, not on disk.

Tier 2 runs in a **Deno subprocess** with `--no-read --no-write --no-net --no-env --no-prompt --no-npm --no-remote`. The subprocess gets the locked SDK — only:

- `ctx.query.*` — over the plugin's own `cms_public.plugin_<slug>.<table>` schema
- `ctx.api.*` — visitor-side public read API
- `ctx.theme` — read-only theme tokens + locale
- `ctx.visitor` — visitor identity from the cookie
- `ctx.captcha` — CAPTCHA / PoW gate

**No** `ctx.cms`, **no** `ctx.ai`, **no** `ctx.snapshots`, **no** `ctx.tools`, **no** `ctx.email`, **no** `ctx.workers`. A Tier 2 manifest declaring `requestedCapabilities` is rejected by the validator.

**How to ship one (the AI-authored path):**

1. Open `/edit` on your install, ask the chat: "draft a Tier 2 plugin called `event-rsvp` that lets visitors sign up for events; schema needs name, email, eventId; component renders a form."
2. The AI calls `submit_plugin` with the source. The validator runs synchronously (oxc-parser walks the JS module tree, rejects forbidden patterns: `fetch`, `Deno.*`, dynamic `import()`, raw SQL, `eval`).
3. If validation passes → status `awaiting_activation`; the AI tells you "click Approve at /security/plugins/event-rsvp" and **does not claim the plugin is active**.
4. You navigate, review the source diff + the schema, click Approve.
5. The host provisions `cms_public.plugin_event_rsvp.*`, registers the plugin's operations, mounts the Web Component on next render.
6. Visitors interact; the AI can summarise data via `ctx.api.*` reads.

**How to ship one (Owner-authored path):**

Same flow, but you write the source directly in the `/security/plugins/new` form (or open a PR with the source under a new `packages/plugins/<slug>/` directory; the install picks it up at next bootstrap).

## Validator rules (both tiers)

The validator (`packages/plugin-sandbox/src/validate.ts`, oxc-parser-based) rejects:

- Imports of any module other than `@caelo/plugin-sdk`
- `CallExpression` of `fetch`, `XMLHttpRequest`, `WebSocket`, `globalThis.fetch`
- Any reference to `Deno.*` (Tier 2 wouldn't get filesystem access anyway, but defense-in-depth)
- Dynamic `import()` calls
- Template literal strings containing SQL keywords (use `ctx.query.*` instead of raw SQL)
- `eval`, `Function`, `new Function`
- Top-level `globalThis` writes

Plus a schema rule: any table declaring a `page_id` column **must** also declare `locale`. Per-page plugin data is locale-aware by default.

## Web Components for the visitor side

Both tiers' frontend code is a Web Component, mounted in **Shadow DOM (open mode default)** so plugin CSS doesn't leak into the host page and vice-versa. Theme tokens are injected as CSS custom properties on the shadow root automatically.

```ts
import { defineComponent } from "@caelo/plugin-sdk";

export const component = defineComponent({
  tag: "caelo-event-rsvp",
  async mounted(host, { theme, visitor }) {
    const root = host.shadowRoot ?? host;
    root.innerHTML = `<form>...</form>`;
    // ...
  },
});
```

Static-generator bakes the initial render at deploy; the component fetches deltas at runtime via `ctx.api.list({ since: <build-timestamp> })`.

## What's in the SDK

Full surface in [`packages/plugin-sdk/src/`](https://github.com/caelo-cms/caelo-cms/tree/main/packages/plugin-sdk/src). The relevant types:

- `definePlugin(spec)` — entry point
- `defineComponent(spec)` — Web Component wrapper
- `PluginContext` — the Tier 2 base shape
- `PluginContextTier1` — extends Tier 2 with the elevated handles
- `PluginQuery`, `PluginCms`, `PluginAi`, `PluginSnapshots`, `PluginTools`, `PluginTheme`, `PluginEmail`, `PluginVisitor`, `PluginCaptcha` — capability handles

## Activation gates

- **Tier 1**: signed-manifest verification at startup using the embedded Caelo public key. Mismatch → refuse to load + insert a `plugins` row with `status='failed'`. Owner can disable from `/security/plugins`; re-enable runs the verify path again.
- **Tier 2**: AI submits → validator → status `validated` → `awaiting_activation`. AI cannot promote to `active` (`ActorScopeRejected`). Owner clicks Approve → `active`. Required by [CMS_REQUIREMENTS](https://github.com/caelo-cms/caelo-cms/blob/main/CMS_REQUIREMENTS.md) §17.4.

## Next

- [Tier 2 deep dive →](/plugins-tier-2)
- [Architecture →](/architecture)
- The [`@caelo/plugin-sdk` source](https://github.com/caelo-cms/caelo-cms/tree/main/packages/plugin-sdk)
