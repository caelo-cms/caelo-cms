# Plugin places in the live editor's toolbar

The live editor's top bar has three groups: the **page** (an address bar with
the SEO info, the page picker and the page's status), the **chat's work**
(Diff), and **getting it out** (Staging, Publish live). Next to the address
bar, plugins can claim a place: an icon that shows the plugin's state for the
shown page and opens a popover with details and "ask the AI" buttons. The
`international-site` plugin uses it for the page's language.

A place is **data**, declared in the manifest as `editorToolbar`
(`packages/plugin-sdk/src/editor-toolbar.ts`). No plugin ships editor UI code;
the admin renders every place with one generic button and popover
(`apps/admin/src/lib/components/edit/PluginToolbarSlots.svelte`).

## Declaration

```ts
editorToolbar: [{
  id: "languages",            // unique in the plugin
  title: "Languages",         // tooltip and popover heading
  icon: "globe",              // the admin panels' icon set
  operation: "editor_languages",
  permission: "content.read", // who sees the place
  prompts: [                  // up to three "ask the AI" buttons
    { label: "Translate this page", text: "Translate {page} into every missing language." },
  ],
}],
```

At most two places per plugin. The manifest check refuses an `operation`
the plugin does not declare and an `id` used twice.

## State

The admin calls `operation` with `{ pageId }` for the page the editor shows
and validates the answer against `pluginEditorToolbarState`:

| Field | Shown as |
|---|---|
| `label` (up to 8 characters) | text next to the icon, e.g. `DE` |
| `count` | a number on the icon; 0 shows nothing |
| `tone` (`neutral`, `attention`, `problem`) | the count's colour |
| `summary` | the tooltip and the popover's first line |
| `items` (up to 20) | popover lines: `label`, `detail`, `tone`, `current`, and `pageId`, which opens that page in the editor |
| `hidden: true` | the place is left out for this page |

A language without a version of the page is not a `problem`: missing
translations are a clean 404 by design (CMS_REQUIREMENTS §7.2).

## Guarantees

- **Activation is a hard state** (CLAUDE.md §2). Places come from the running
  host's loaded plugins (`#lib/server/plugin-toolbar.ts`); an inactive plugin
  has none.
- **Read-only, on the draft.** The operation runs as a `render` invocation on
  the editor's chat branch: it sees the chat's draft and cannot write. A
  runtime-installed plugin reaches its public tables there, not its private
  storage, the same as in any other render call.
- **Untrusted output** (#635). The answer is Zod-validated; a value outside
  the schema replaces the whole state with an error. Every value renders as
  text. An entry's `pageId` is offered only for a page the editor knows.
- **Loud failures** (#1008). A failing operation or an invalid answer keeps
  the place in the bar with a red dot and the reason; it is never hidden.
- **The operator sends.** A prompt only puts its text (with `{page}` replaced
  by the page's path) into the chat composer. The text is part of the
  approved manifest and the installation review shows it.
- **Order and room.** Plugins in slug order, places in declaration order. Up
  to three places show; from four on, two show and the rest share one `+N`
  popover.
- **Streamed.** The editor does not wait for plugin operations; the places
  appear when they answer.
