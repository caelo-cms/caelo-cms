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
  editable in place. Enter or clicking elsewhere saves, Escape restores.
- **Edit link…** (on a link whose target and/or text is a field) edits the
  text and the target together, with the site's pages as suggestions.
- **Replace image…** (on an image whose address is a field) opens the media
  library; the pick replaces the image, and its alt text fills the image's
  alt field when that field is not also shown as text on the page.
- Content shared with other pages (a synced placement on more than one page)
  asks first: **Change on all N pages** or **Only on this page** (the page
  gets its own copy).
- **Ask AI** adds the reference to the *current* chat (chips append, never
  fork — CLAUDE.md §2), expands a collapsed chat and focuses its composer. The
  operator types the instruction there and sends it with Enter.

Why the instruction is not typed in the preview: the preview runs the site's
own module scripts, so anything the iframe posts can come from those scripts
as well as from the operator. A message from the preview may point at an
element (add a chip); it never carries an instruction and never sends one.
The send is always the operator's own action in the editor.

## The preview is sandboxed (#946)

Module HTML is AI-authored or imported from other sites, so its scripts are
untrusted. They never run with the operator's admin session:

- Every preview iframe is `sandbox="allow-scripts"` **without**
  `allow-same-origin`, and every preview document is served with
  `Content-Security-Policy: sandbox allow-scripts` (so opening one directly in
  a tab is sandboxed too). The page's scripts run in an opaque origin: no
  access to the editor's DOM, cookies or storage, and their requests to the
  admin carry no session.
- The editor and the preview talk only over `postMessage`
  (`iframe-protocol.ts`, Zod-validated). Each editor mount puts a random
  `channel` in the iframe URL; both sides drop messages without it, so a page
  the preview navigated to cannot talk to the editor.
- The preview's own navigations carry no session either, so link clicks and
  reloads are `caelo:navigate` requests: the editor checks the target is a
  preview page and loads it into the iframe.
- Media loads through a short-lived, read-only grant cookie
  (`SameSite=None`, scoped to `/_caelo/`, set with each preview response);
  theme fonts are inlined as `data:` URIs (font loads from an opaque origin
  are credential-less CORS requests).
- Site scripts that use `document.cookie` or `localStorage` see them throw in
  the preview (on the live site they work as usual).
- The AI's in-browser screenshot renders the preview HTML in a frame with
  `allow-same-origin` and no scripts; script-built DOM is not in it.
- Staged pages proxied from the admin (`/_staging-preview`) keep their origin
  so their assets load, and run no script.

The menu, toolbar and target outline live in a shadow root appended
to the site's `<body>`: site CSS cannot restyle them and they never touch the
site's own elements. Panels flip below/above and clamp into the viewport so a
site's fixed navigation cannot hide them.

## Code

| Piece | File |
|---|---|
| Runtime injected into the preview (navigation, reload) | `apps/admin/src/lib/components/edit/inject-script.ts` |
| Menu, toolbar, reference building | `apps/admin/src/lib/components/edit/edit-affordances-script.ts` |
| postMessage types + Zod schemas, channel, navigation check | `apps/admin/src/lib/components/edit/iframe-protocol.ts` |
| Preview sandbox headers, font inlining | `apps/admin/src/lib/server/preview-sandbox.ts` |
| Read-only media grant for the sandboxed preview | `apps/admin/src/lib/server/preview-asset-grant.ts` |
| Chip + Ask AI (composer focus) in the chat | `apps/admin/src/lib/components/chat/ChatPanel.svelte` (`caelo:chip` window event) |
| Expanding a collapsed chat on a reference | `apps/admin/src/lib/components/edit/Overlay.svelte` |
| Chip schema (Zod, validated by the stream endpoint) | `chatChipSchema` in `packages/shared/src/ai-tools.ts` |
| List entry references (`data-caelo-list-item` parser) | `packages/shared/src/lists/item-attr.ts` |
| What the AI reads | `buildUserContent` in `packages/admin-core/src/ai/chat-runner/persistence.ts` |
| Field markers in the preview | `packages/shared/src/edit-markers.ts`, used by `pages.render_preview` with `editMarkers: true` |
| In-place editing runtime | `apps/admin/src/lib/components/edit/field-edit-script.ts` |
| Link editor, image replace | `apps/admin/src/lib/components/edit/link-image-edit-script.ts` |
| Saving an edit | `editFields` action in `apps/admin/src/routes/(authed)/edit/+page.server.ts` → `page_module_content.patch_fields` (`packages/admin-core/src/ops/content/page-module-patch.ts`) |

## The reference

```ts
{
  moduleId: string;      // full uuid of the nearest module root (data-caelo-module-id); inside a sub-module of a module / module-list field that is the sub-module (#1027)
  selector: string;      // element path from the module root, e.g. "section.hero > h1"; "" for dropdown picks
  label: string;         // module root + its first heading, for the chip
  selectedText?: string; // what the operator selected (≤ 2000 chars)
  context?: string;      // text of the block the reference sits in (≤ 500 chars)
  blockName?: string;    // the marked placement field the text comes from (#917) …
  position?: number;
  field?: string;
  item?: string;         // … and, for a module's own list, the entry id
  key?: string;          //     and the entry field the text is
  listItem?: string;     // data-caelo-list-item of the list entry the element sits in (epic #1107)
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

### List entries (epic #1107)

The template engine stamps `data-caelo-list-item` on the root element of
every rendered stored list entry (`docs/lists.md` §13). A reference built
inside one carries that value as `listItem`, and the chip's label starts with
the entry's text (`Entry “About” · nav`), so pointing at a menu item points
at that menu entry, not at the whole header. The AI reads it in the
coordinates its tools take:

| `data-caelo-list-item` | the AI reads | edited with |
|---|---|---|
| `<listId>/<itemId>` (shared list) | `list entry=(shared list=<listId>, entry=<itemId>)` | `get_list` / `patch_list_items_many` |
| `instance/<ciId>/<field>/<itemId>` (a module's own list) | `list entry=(content instance=<ciId>, list field=<field>, entry=<itemId>)` | the content tools on that instance |
| `local/<field>/<itemId>` (a field default, site chrome) | `list entry=(default of list field=<field>, entry=<itemId>)` | the module (the default is part of it) |

Generated entries (queries, system and plugin sources) carry no stamp, so a
reference inside one names the module only. Two entries of one menu share
an element path; the chat keeps one chip per entry (`listItem` is part of
the de-duplication). The value is validated against `LIST_ITEM_ATTR_RE`
(`packages/shared/src/lists/item-attr.ts`) by the protocol and the chip
schema.

## Field markers and in-place editing (#917)

`pages.render_preview({ editMarkers: true })`, which only the editor's preview
iframe asks for, wraps every plain-text value of a page placement in comments:

```html
<h1><!--caelo:f p=content%230 s=0 f=title-->Welcome<!--/caelo:f--></h1>
```

`p` is the placement (`<blockName>#<position>`, URI-encoded), `s` is 0 for a
placement with its own content and, for a synced (shared) one, the number of
pages showing it; `f` is the field path: `title`, or for an entry of a
module's own list (a `list` field, epic #1107) `<field>.<entry id>.<key>`
(`links.<id>.label`), with `.href` for a link's target. Values that carry
markup, empty values and other field kinds are not marked. Entries of a
shared list are not marked: they are edited in *Content → Menus & lists*, or
by the AI through the list entry reference below.

A tag whose `href`, `src` or `alt` is exactly one marked value (#918) gets the
same information as attributes, e.g.
`<a href="/docs" data-caelo-fields="href=links.<entry id>.link.href" data-caelo-placement="content%230" data-caelo-shared="0">`.
An attribute assembled from several parts (`href="/blog/{{slug}}"`) is not
editable and not marked. A value used in an attribute,
comment, `<script>`, `<style>`, `<title>` or `<textarea>` renders exactly as
without markers. Variant content (#592) and layout chrome are not marked.
Published output never contains markers.

Saving goes through `page_module_content.patch_fields`
`{pageId, blockName, position, edits: [{field, item?, key?, part?, text}], scope?}` (bulk-first:
several values of one placement in one call and one snapshot): it resolves the
placement through the caller's branch-overlaid layout (the view the preview
renders), refuses synced placements, escapes `&`, `<`, `>` once (text fields
are substituted unescaped), patches only those fields or items (all or none), and writes via
`content_instances.set_values` (lock, version check, snapshot), so chat Undo
reverts it. The preview reloads after every save, success or not.

`item` + `key` address one field of one list entry; `part: "href"` picks a
link's target instead of its text. Link targets (`url` fields, `link` entry
fields) must be a path, `#…`, `http(s)://`,
`mailto:`, `tel:` or `caelo:` reference; image addresses a path, `http(s)://`
or `caelo:media/` reference; neither may contain quotes, angle brackets or
spaces. Both are stored as typed (the write-boundary canonicaliser of epic
#724 turns internal paths into page references once it runs). A synced
placement needs `scope`: `everywhere` writes the shared instance, `here` runs
`placement.fork_content` first and writes the copy, in the same transaction.

