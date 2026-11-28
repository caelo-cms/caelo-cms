# Draft changes and the Publish live review

Live Edit shows the operator what a click changes before the click, at
both steps between draft, staging and live. Both lists use the same
words (Draft, Staged, Live) and count what an operator recognises: one
page, however many of its parts changed, or one part that shows on many
pages.

## Where a part counts

A section design (module) or a section's content (content instance) is
counted where it shows, by the same rule in both lists
(`ops/content/part-where.ts`):

- **On one page:** a change of that page. Every placement holds its own
  content instance since v0.12, so editing one section's text is, by
  entity, a content-instance change; the operator sees a changed page. A
  new section design made for a new page belongs to that page.
- **On no page:** not listed. An unused section design or content nothing
  shows changes nothing for a visitor. A conversation with only such
  changes reads "Nothing visitors see".
- **On two or more pages, in a layout's chrome or in a shared list:**
  site-wide, saying where: "Section design · on 4 pages", "Shared content
  · in the site layout". Unnamed content is named by its section design,
  never by its id.

`loadPartPlacements` (`ops/content/part-placement.ts`) reads where each
part renders: a content instance through `loadContentInstanceReach`
(placements, parents, module defaults, shared lists), a module through its
instances plus the layouts whose chrome places it. Every read is bounded
per part: a module's instances up to `PART_INSTANCE_CAP` (100), an
instance's placements up to `PART_PAGE_CAP` (100, the reach's
`placementsPerSource`); past either it shows "on many pages". All parts
are read in one batch (about twenty statements however many changed), so
the cost follows the changed parts, never how widely a section design or a
synced content is used: on a 5,000-page bench with 208 changed parts and a
CTA synced on every page, `chat.list_open_changes` spent 13.8 ms in
Postgres (11.9 ms before) and `deploy.publish_preview` 19.2 ms (3.8 ms).
Templates, the layout, the theme, lists, list and page types and plugin
data stay site-wide by nature.

Orphaned content (no page shows it) is not a finding of the review or the
quality check, which audit what visitors get. Where it comes from and how
it is cleaned up is #1626.

## Draft changes (before Stage)

The Staging button reads "N draft changes": the changes in the
operator's own conversations that are not on staging yet. Its menu lists
those conversations (`DraftChatList.svelte`). The same list is the page
Content → Changes, which adds Discard.

- **Only the operator's own conversations.** Those are the ones they can
  stage; another editor's work is theirs (decision 2026-11-17). The list
  is `chat.list_open_changes` with `mineOnly`.
- **This chat first.** In Live Edit the conversation on screen is first,
  highlighted, and the only one ticked when the menu opens. "Stage now"
  stages one conversation, "Stage selected" the ticked ones, "Stage all"
  every one; the form posts `only`, the ticked `chatSessionId`s or `all`
  (`#lib/server/stage-selection.ts` checks them against the list). One
  Stage is one build, as before (`carryStage` → `stageChatSessions`).
- **Counts per conversation.** `chat.list_open_changes` returns a
  `summary` per chat (`ops/chat/draft-summary.ts`): new, changed and
  removed pages and site-wide changes, and one detail row per page or
  part, worded by rules (no AI call). A page is new when its row exists
  only in the draft (`pages.chat_branch_id`), removed when its newest
  draft state is deleted; one made and deleted again in the draft is left
  out. Section designs and content count where they show as the chat's
  branch sees the site (above), draft pages included.
- **Open chat** links `/edit?chat=<id>&page=<anchor page>`: without the
  page, a page-bound chat is not found among the shown page's chats.

The yellow "Also pending" strip above the toolbar is gone; its op
`chat.list_open_with_pending` with it.

## The Publish live review (before Publish live)

Every Publish live click opens the review first (`PublishLiveReview.svelte`).
It reads `GET /api/deploy/publish-preview`: `deploy.publish_preview`
(`ops/deploy-publish-preview.ts`) and `redirects.release_plan`. Numbers
first, three examples per area, the full list on request; Publish live
at the top and the bottom.

`deploy.publish_preview` compares the staged build Publish live copies
with the build that is live. "The live build" is the staging run the live
production site build was promoted from (deploy.promote stamps its id into
the production run's `build_id`), so after a rollback the review compares
with the build that is live again. A plugin-data build (#1155) is a
production run of its own that re-renders baked regions of the live build;
it is skipped, never read as the live build (`deploy/release-runs.ts`;
before #1750 every review after one said live was "built directly" and
listed nothing). Two sources, both recorded by every Stage:

| Source | What it gives |
|---|---|
| The two runs' render fingerprints (`deploy_runs.render_fingerprint`, #553) | New and removed published pages (a `page:` key in one build only), a changed template of a page, changed module code, templates, layouts, the active theme, plugins (on, off, updated), rendered site settings. |
| Snapshot headers staged between the builds (`site_snapshots.staged_at` in [live build start, staged build start), index of migration 0705) | Pages and site-wide parts whose content a Stage merged in between: text and sections, lists, list and page types, shared content, plugin data. |

`deploy/publish-preview.ts` sorts both into the groups (pure, unit
tested). A staged change to a page the staged build does not publish (a
draft page) is not listed. Section designs and content count where they
show on main, which is what the last Stage merged, counting only the
pages the staged build publishes (above). When a later Stage merged on top
of the staged build and its build did not finish (it failed, or still
runs), main is newer than the build: the lists are still shown and the
notice says so ("Stage again for an exact list"). The security headers count as
a setting when both builds recorded them and they differ.

**Look before the click.** Every new or changed page links to it on
staging, and every site-wide part to a page that shows it (its first page,
or the home page for layout chrome and lists). On an install with a
protected staging host the link goes through "Open staging"
(`/staging/open?path=`, which signs the operator in there); a development
checkout links to its local staging port; aws / azure, which have no
staging site yet, show no links. `GET /api/deploy/publish-preview` says
which (`staging`, `#lib/server/staging-link.ts`); `#lib/staging-href.ts`
builds the links in the browser. A removed page has no link: staging no
longer has it.

When the builds cannot be compared, the lists stay empty and `notice`
says why, never a list that reads complete but is not: nothing staged
yet, a staged build from an older Caelo version (no fingerprint), the
first Publish live (every published page is listed as new), live built
directly by an Owner's production build (it has no source staging run),
and a live build newer than the staged one.

What it does not see: content written on main outside a Stage (main
writes are not staged headers) shows only as far as the fingerprint
covers it, and a static file's content (#1461) is not listed.

**Exactly what it showed goes live.** The review's form posts the staged
run it showed (`stagedRunId`): `deploy.start_promote` refuses when
staging was rebuilt since ("Open Publish live again to review the new
build"). The redirect changes it listed as going live ride the same
form (`redirectChanges`, #1550).

The AI reads the same data: `list_unpublished_changes` appends what the
next Publish live ships (`ai/tools/_publish-preview-note.ts`). Its own
part lists the chat's changes in two halves (`chat.list_pending_changes`):
unstaged (the chat's draft head) and staged, which is what the chat's
Stages merged at or after the start of the staging build live was copied
from (`site_snapshots.staged_at`, `notLiveSince` in
`deploy/release-runs.ts`). It lists the newest 100 staged snapshot headers
and says when older ones are not listed; migration 0915 indexes the read by
the chat's tasks (shared draft) and by branch (isolated chats), so it costs
the page it lists. A Stage takes its snapshots out of the draft head, so
before #1750 a staged change vanished from the chat's list although no
Publish live had shipped it.

Publish live from the pages list, Settings → Deployments and the
approval card of `propose_deploy_promote` does not show the review yet
(#1568).
