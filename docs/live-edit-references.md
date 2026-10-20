# Live Edit: element references from the preview

How an operator points the AI at something on the page in Live Edit, and what
the AI receives. Introduced in #916; direct inline editing (#917, #918) builds
on the same runtime.

## Interaction

There is no edit mode. In the preview iframe:

- **Left click** behaves like the live site (links navigate inside the editor).
- **Selecting text inside a module** shows a small toolbar: *Ask AI* and *Add to chat*.
- **Right-click inside a module** opens the Caelo menu: *Ask AI about this…*,
  *Add to chat as reference*, *Select whole section*. **Shift+right-click** keeps
  the browser's own menu; a right-click outside any module does too.
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

## The reference

```ts
{
  moduleId: string;      // full uuid of the module root (data-caelo-module-id)
  selector: string;      // element path from the module root, e.g. "section.hero > h1"; "" for dropdown picks
  label: string;         // module root + its first heading, for the chip
  selectedText?: string; // what the operator selected (≤ 2000 chars)
  context?: string;      // text of the block the reference sits in (≤ 500 chars)
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
