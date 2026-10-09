---
slug: admin-live-edit
template: doc-page
status: published
seo:
  title: Live-edit overlay — Caelo CMS
  description: Your real site in an iframe + a floating AI chat overlay. Click an element, ask the AI, watch it change in place.
---

# The live-edit overlay

This is the surface the rest of the architecture exists for.

## What you see

When you open `/edit`, the admin renders **your actual site** in a chrome-less iframe — no admin chrome, no sidebar, just the page exactly as a visitor would see it (modulo `data-caelo-module-id` attributes injected for click-targeting). On top floats a chat overlay you can drag, pin to the bottom or right edge, or collapse.

Every substantial Stage is checked with Lighthouse before it can go live — see [the quality gate](/quality-gate).

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

## Stage + Publish live

When you have pending changes, the toolbar shows:

- A pending-changes pill: `1 pending change` / `5 pending changes`
- A **Stage** button — merges the chat's changes into the site and rebuilds the staging site
- (After staging) a preview link + a **Publish live** button

The AI stages finished work itself: you describe what you want, it makes the changes, stages them and checks the staging build (Lighthouse quality check). **Publish live is always your click** — nothing the AI staged ever goes live on its own, not even with automatic redeploys switched on. Staging gives you a preview URL you can share before production changes.

Sections built from smaller pieces — a grid of cards, a pricing table of plans, a list of FAQ items — are published exactly as the editor preview shows them. If a piece cannot be rendered (for example, a card list still points at a card that was deleted), the Stage stops instead of publishing the section empty, and the message names the page, the section and the field to fix.

## One shared draft

All chats work in the site's **shared draft**: open two chats and each sees the other's unstaged changes in its preview. Chats are conversations, not separate copies of the site.

- **Same thing, two chats:** if another chat changed a module or page after this chat last looked at it, the AI gets a gentle conflict, re-reads it and redoes its edit on the current version — nothing is silently overwritten.
- **Undo a chat:** ask the AI to undo this chat. If another chat has since built on the same thing, the AI tells you ("this also undoes X from chat Y") and asks before going ahead.
- **Stage a selection:** Stage merges exactly the chosen chats' changes. If another chat changed the same module, its change comes along and the result says so.

**Experiments get their own branch.** Ask the AI to *try* something ("try a redesign of the homepage") or start a site migration, and that chat works on an isolated branch: nothing it does shows up in the draft or other chats until it is staged. You can also start one yourself: **New experiment** in the chat menu. Chats that existed before the shared draft keep their own branches until they are staged or discarded.

When a chat writes something an experiment (or an older chat) has unstaged changes on, it **takes that change over**: the change moves into this chat and the new edit builds on it. Both chats are told. Locks never expire on a timer: an expired lock over unstaged work would let the next Stage silently overwrite one of the two versions.

## Open changes

**Content → Open changes** lists every open chat with unstaged work: what each chat changed, what it currently holds, and which changes moved between chats. From there you can:

- **Stage all** — stage every one of your chats in one go (one staging build, one quality check);
- tick some chats and **Stage selected** — so a half-finished chat stays out of staging;
- **Discard** a chat — throw its unstaged changes away and close it (for a draft chat: only its own changes; if another chat built on them, you are asked first).

Other editors' chats are shown read-only, so nobody is surprised when work moves between chats.

A chat with unstaged changes in the shared draft cannot be archived: stage or discard its changes first, so nothing stays in the draft without a chat that owns it. Site chrome the AI adds in a chat (a footer, a header nav) is unstaged work like everything else — it shows in the preview and reaches the site with the next Stage.

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
