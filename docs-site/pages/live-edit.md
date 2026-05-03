---
slug: admin-live-edit
template: doc-page
locale: en
status: published
seo:
  title: Live-edit overlay — Caelo CMS
  description: Your real site in an iframe + a floating AI chat overlay. Click an element, ask the AI, watch it change in place.
---

# The live-edit overlay

This is the surface the rest of the architecture exists for.

## What you see

When you open `/edit`, the admin renders **your actual site** in a chrome-less iframe — no admin chrome, no sidebar, just the page exactly as a visitor would see it (modulo `data-caelo-module-id` attributes injected for click-targeting). On top floats a chat overlay you can drag, pin to the bottom or right edge, or collapse.

The overlay's title bar carries a chat-history dropdown (filtered to chats bound to the current page), a "+ New chat" button, and the position toggles. The toolbar above the iframe carries the URL display, a Back-to-admin link, the page picker, the Stage button, and the Confirm-publish button.

## How you edit

Three flows:

### Conversational

Just type. "Make the headline bigger." "Change the hero color to teal." "Add a section about pricing below the features."

The AI dispatches the right tool — `edit_module` for in-place edits, `add_module_to_page` to insert content, `change_page_slug` for URL changes — and the iframe re-renders within ~2 seconds with the proposed change. The toolbar's pending-changes pill increments.

### Click-to-chat

Hold **Opt + Ctrl + Cmd** (the modifier-gate trio) and click any element in the iframe. A chip appears in the chat composer with the element's stable selector + module id. Click multiple elements; multiple chips accumulate. Then send "make these all teal" and the AI updates all five in one turn.

The `scoped-edit` skill auto-engages whenever chips are present; the AI knows to scope its next edit to the chipped elements and not invent new modules.

### In-iframe navigation

Without the modifier, your clicks pass through normally — links navigate, forms submit, in-page JS runs. The iframe behaves like a real browser session of your site. URL display updates, the chat overlay's branch context follows.

## Stage + Confirm

When you have pending changes, the toolbar shows:

- A pending-changes pill: `1 pending change` / `5 pending changes`
- A **Stage** button — promotes the chat-branch to staging
- (After staging) a preview link + a **Confirm publish** button

Two-step on purpose: staging gives you a non-localhost preview URL you can share before flipping production. The publish action merges the chat's snapshot branch into main; the static-generator (or auto-redeploy hook) picks up the change.

## Branch isolation

Each chat session operates on its own ephemeral preview branch of the snapshot tree. Two editors in two parallel chats see only their own changes — no collision. Branches merge into main only on publish; abandoned chats can be reverted with one click.

## What the toolbar's status colours mean

- **Grey pill** — no pending changes, no staged build
- **Yellow pill** — pending changes exist; haven't staged
- **Blue pill** — staged; preview URL available
- **Green pill** — published in the last 30 seconds (auto-redeploy debouncing)

## Drive it without the browser

The same chat-runner is reachable via [MCP](/mcp). `caelo_chat` from your IDE drives the same edits, lands as the same snapshots, publishes via the same Owner click — except the click happens via an MCP tool call, not a browser button.

## Tips

- **The AI loses context across "+ New chat"** — start a fresh chat for a fresh task; the page-context block re-populates
- **The undo button is the chat history** — click any prior message to revert to that snapshot
- **Site memory shapes the AI's voice** — `/security/ai/memory` carries Owner-curated brand voice, banned phrases, recurring instructions. The AI reads these on every turn.
- **Skills steer behaviour per-task** — engaged skills are listed in the overlay's bottom strip; click to disengage one for the current chat. The matcher restores defaults on a new chat.

## Next

- [Architecture →](/architecture)
- [MCP integration →](/mcp)
- [Build a plugin →](/plugins-build)
