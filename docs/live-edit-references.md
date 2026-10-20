# Live Edit: element references from the preview

How an operator points the AI at something on the page in Live Edit, what the
AI receives, and how text is edited in place without the AI. References came
with #916, in-place text editing with #917; #918 extends it to shared content,
links and images.

## Interaction

There is no edit mode. In the preview iframe:

- **Left click** behaves like the live site (links navigate inside the editor).
- **Selecting text inside a module** shows a small toolbar: *Ask AI* and *Add to chat*.
- **Right-click inside a module** opens the Caelo menu: *Ask AI about this…*,
  *Add to chat as reference*, *Select whole section*. **Shift+right-click** keeps
  the browser's own menu; a right-click outside any module does too.
- **Edit text** (menu) / **Edit** (toolbar) makes exactly that field's text
  editable in place. Enter or clicking elsewhere saves, Escape restores. Text
  used on other pages too (a synced placement) is not edited in place yet; the
  item is disabled and says to ask the AI.
- **Ask AI** opens a one-line prompt at the spot. Enter sends it into the
  *current* chat together with the reference (chips append, never fork —
  CLAUDE.md §2). If the operator has a draft or a turn is running, the prompt
  joins the composer draft instead of being sent.

The menu, toolbar, prompt and target outline live in a shadow root appended
to the site's `<body>`: site CSS cannot restyle them and they never touch the
site's own elements. Panels flip below/above and clamp into the viewport so a
site's fixed navigation cannot hide them.

## Code

| Piece | File |
|---|---|
| Runtime injected into the preview (navigation, reload) | `apps/admin/src/lib/components/edit/inject-script.ts` |
| Menu, toolbar, Ask AI, reference building | `apps/admin/src/lib/components/edit/edit-affordances-script.ts` |
| postMessage types (`caelo:element-referenced`) | `apps/admin/src/lib/components/edit/iframe-protocol.ts` |
| Chip + Ask AI handling in the chat | `apps/admin/src/lib/components/chat/ChatPanel.svelte` (`caelo:chip` window event) |
| Expanding a collapsed chat on a reference | `apps/admin/src/lib/components/edit/Overlay.svelte` |
| Chip schema (Zod, validated by the stream endpoint) | `chatChipSchema` in `packages/shared/src/ai-tools.ts` |
| What the AI reads | `buildUserContent` in `packages/admin-core/src/ai/chat-runner/persistence.ts` |
| Field markers in the preview | `packages/shared/src/edit-markers.ts`, used by `pages.render_preview` with `editMarkers: true` |
| In-place editing runtime | `apps/admin/src/lib/components/edit/field-edit-script.ts` |
| Saving an edit | `editFieldText` action in `apps/admin/src/routes/(authed)/edit/+page.server.ts` → `page_module_content.patch_fields` (`packages/admin-core/src/ops/content/page-module-patch.ts`) |

## The reference

```ts
{
  moduleId: string;      // full uuid of the module root (data-caelo-module-id)
  selector: string;      // element path from the module root, e.g. "section.hero > h1"; "" for dropdown picks
  label: string;         // module root + its first heading, for the chip
  selectedText?: string; // what the operator selected (≤ 2000 chars)
  context?: string;      // text of the block the reference sits in (≤ 500 chars)
  blockName?: string;    // the marked placement field the text comes from (#917) …
  position?: number;
  field?: string;
  index?: number;        // … and its list item, for text-list / link-list
}
```

The iframe clips to the schema's limits (`REFERENCE_LIMITS`, kept in sync by a
unit test). The persisted user message lists each reference with the full
module id and JSON-quoted texts, e.g.:

```
Element references attached to this message:
  - section.hero “Welcome” (module=6f1c…e6f7, element=section.hero > h1)
    selected text: "Welcome to our shop"
```

Operator-facing captions show only the text the operator picked or clicked,
never element paths or class names (CLAUDE.md §1A).

Pinned chips persist the module + element only; the selected text belongs to
the message it was picked for.

## Field markers and in-place editing (#917)

`pages.render_preview({ editMarkers: true })`, which only the editor's preview
iframe asks for, wraps every plain-text value of a page placement in comments:

```html
<h1><!--caelo:f p=content%230 s=0 f=title-->Welcome<!--/caelo:f--></h1>
```

`p` is the placement (`<blockName>#<position>`, URI-encoded), `s=1` marks a
synced (shared) placement, `f` the field path: `title`, `tags.1` (text-list
item), `links.0.label` (link-list label). Values that carry markup, empty
values and other field kinds are not marked. A value used in an attribute,
comment, `<script>`, `<style>`, `<title>` or `<textarea>` renders exactly as
without markers. Variant content (#592) and layout chrome are not marked.
Published output never contains markers.

Saving goes through `page_module_content.patch_fields`
`{pageId, blockName, position, edits: [{field, index?, text}]}` (bulk-first:
several values of one placement in one call and one snapshot): it resolves the
placement through the caller's branch-overlaid layout (the view the preview
renders), refuses synced placements, escapes `&`, `<`, `>` once (text fields
are substituted unescaped), patches only those fields or items (all or none), and writes via
`content_instances.set_values` (lock, version check, snapshot), so chat Undo
reverts it. The preview reloads after every save, success or not.

