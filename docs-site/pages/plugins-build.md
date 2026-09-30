---
slug: plugins-build
template: doc-page
status: published
seo:
  title: Build a plugin — Caelo CMS
  description: One plugin model for every plugin. Base capabilities are always available; everything else is an Owner-approved grant bound to the exact plugin version.
---

# Build a plugin

Every Caelo plugin is the same kind of thing — whether it ships with a Caelo release or is installed on your site at runtime, and whether a person or the AI wrote it. **Who wrote a plugin grants it nothing.** A plugin gets a small base set of capabilities; everything beyond that is a grant the Owner approves for exactly that version of the plugin. The rules are on [Plugin permissions](/plugins-permissions).

## Two ways a plugin arrives

- **Installed at runtime (the usual path).** Ask the chat on `/edit`: "build a plugin called `event-rsvp` that lets visitors sign up for events; schema needs name, email, eventId; component renders a form." The AI calls `submit_plugin`; the validator runs; the plugin lands at `/security/plugins` awaiting your approval. Its source is stored in the database.
- **Shipped with a release.** Plugins under `packages/plugins/<slug>/` in the source repository change like any other code — through a reviewed pull request and a Caelo release. Their manifest is signed, which proves the installed artifact is the released one. The signature is shown to you at approval; it unlocks nothing by itself.

## The shape

```ts
import { definePlugin } from "@caelo-cms/plugin-sdk";

export default definePlugin({
  slug: "event-rsvp",
  version: "1.0.0",
  schema: {
    signups: { id: "uuid", event_id: "string", name: "string", email: "string" },
  },
  // Operations a visitor may call through the API gateway. Default deny:
  // anything not listed here is unreachable from the public site.
  publicOperations: ["signup"],
  operations: {
    signup: async (ctx, args) => ctx.query.insert("signups", args as never),
    list: async (ctx) => ctx.query.list("signups", { orderBy: "created_at" }),
  },
});
```

## Asking for more than the base

A plugin that needs more — its own private storage, read access to the media library, chat tools for the AI, AI or image generation, background jobs, email — declares the grants it needs in its manifest. At approval the Owner sees each grant and what it allows, including every tool name and description the AI would see. A new version of the plugin is a new artifact and is approved again.

Core data (pages, modules, media, …) is never reached directly: a grant for a domain allows its named Query API operations and nothing else, and writes behave like every other write in Caelo — validated, audited, snapshotted, and on the chat's branch until published. See [Plugin permissions](/plugins-permissions).

## Validator rules

The validator (`packages/plugin-sandbox/src/validate.ts`, oxc-parser-based) runs before every load and rejects:

- Imports of any module other than `@caelo-cms/plugin-sdk`
- `require` in any spelling, `import.meta`, dynamic `import()`
- `fetch`, `XMLHttpRequest`, `WebSocket`
- Any reference to `Deno.*`
- Template literals containing SQL keywords (use `ctx.query.*`)
- `eval`, `Function`, `new Function`
- Top-level `globalThis` writes

Failures return structured errors the AI fixes and re-submits in the same turn.

## Web Components for the visitor side

A plugin's frontend is a Web Component in **Shadow DOM (open mode by default)**, so plugin CSS never leaks into the page and vice versa. Theme tokens arrive as CSS custom properties on the shadow root.

```ts
import { defineComponent } from "@caelo-cms/plugin-sdk";

export const component = defineComponent({
  tag: "caelo-event-rsvp",
  async mounted(host, { theme, visitor }) {
    const root = host.shadowRoot ?? host;
    root.innerHTML = `<form>...</form>`;
  },
});
```

The static generator bakes the initial render at deploy; the component fetches deltas at runtime via `ctx.api.list({ since: <build-timestamp> })`.

## Activation

Nothing of a plugin runs until an Owner activates it at `/security/plugins` — shipped plugins included. The AI can submit a plugin and propose its activation; only a human Owner activates it and approves its grants.

## Next

- [Plugin permissions →](/plugins-permissions)
- [Architecture →](/architecture)
- The [`@caelo-cms/plugin-sdk` source](https://github.com/caelo-cms/caelo-cms/tree/main/packages/plugin-sdk)
