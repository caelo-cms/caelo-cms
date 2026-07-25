-- SPDX-License-Identifier: MPL-2.0
--
-- 0187 — site-migrate: import-first media, inspect-only homepage, nav-to-slug,
-- narration. Follows the tooling changes in this batch:
--   * migrate_media (scan-and-rewrite) was REMOVED; source media now enters via
--     `import_media_from_urls` (explicit URLs the AI names) which returns Caelo
--     media URLs, plus `list_page_assets` for the full/searchable list and the
--     inspect `images` facet for the top-20. So the flow becomes IMPORT-FIRST:
--     fetch the assets, then build with the Caelo URLs directly — no "hotlink
--     then re-host" loop (operator directive).
--   * The homepage/key-types no longer need the crawl — `inspect_external_page`
--     gives content + screenshot + tokens + asset URLs live. The crawl
--     (`propose_site_import`) stays ONLY for the mass import (step 5).
--   * Nav/CTAs link to the INTENDED slug (never a `#` placeholder) so links
--     resolve once the target page is built (a stage/publish link-integrity
--     check now flags dead ones).
--   * Narrate each step (no empty tool-only turns).
-- Surgical replace()s on the #278/0178 body, each idempotent by distinctive
-- substring. Preserves the 0183 CANONICAL-ROOT hardening.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- R1 — homepage: inspect LIVE, no crawl.
UPDATE skills SET body = replace(body,
  $o$   - Bring in the source truth for JUST THE HOMEPAGE with a SCOPED, list-mode import — the homepage URL alone (at most 1–2 further pages it links to, and ONLY if you genuinely need them for context — NOT the type samples; those come in step 4). Use `propose_site_import` in LIST mode with those specific `urls`, NEVER a depth crawl of the origin. This gives you the stored source screenshot (fidelity ground truth) and design tokens. It is a TWO-STEP flow: (1) you propose, (2) the operator clicks APPROVE on the proposal card — it is pinned in the "Pending your approval" strip right above the chat input, so say exactly that: "Ich habe die Startseite vorbereitet — hit Approve right above the input box and I'll continue automatically." Never send them to an admin page, and NEVER claim the crawl ran, is running, or succeeded before it did. After their click you get an automatic "Approved" message; the fetch runs in the BACKGROUND (~a minute) and an automatic status message arrives when it reaches `ready_for_review` — while it is still `crawling`, say so in one sentence and continue the moment it is ready.$o$,
  $n$   - INSPECT the homepage LIVE — no crawl for the homepage. `inspect_external_page({url, facets:{markdown:true, meta:true, screenshot:true, tokens:true, images:true}})` returns the content (Markdown), a visual reference (screenshot), the real palette + typography (tokens — never guess a palette you can measure), and the TOP-20 source ASSET URLs (images, logo, CSS backgrounds — the `images` facet; the FULL searchable list is `list_page_assets` once a crawl exists in step 5). For one section of a big page use `query_page_html({pageRef, describe})`; page long Markdown with `read_page_more`. The full-site crawl (`propose_site_import`) is ONLY for the mass import (step 5) — the homepage needs no crawl and no operator Approve here.$n$
) WHERE slug = 'site-migrate';

-- R2 — logo: import it, reference the Caelo URL.
UPDATE skills SET body = replace(body,
  $o$     - THE HEADER LOGO IS THE OPERATOR'S REAL BRAND FILE — IMPORT IT, NEVER REDRAW IT. The altTexts facet already gave you the source logo's <img> src (or inline <svg>); a logo is a brand IMAGE, not design for you to recreate. Put the real logo in the header ONE of two ways: (a) keep the source logo as a real <img> in the header html so `migrate_media` downloads and re-hosts it to Caelo media, OR (b) bind it once with `set_theme_asset({slot:'logo'})` and reference `{{theme_logo_url}}` in the header (do the favicon the same way: `set_theme_asset({slot:'favicon'})`). NEVER hand-author the logo as a text/CSS wordmark or an HTML/CSS/SVG shape — a redrawn logo is a migration defect, and `migrate_media` now flags a header that carries no Caelo-hosted logo <img>, no `{{theme_logo_url}}`, and no bound theme logo asset while the source header had a real logo image. The ONLY time a text logo is acceptable is when the source brand itself is genuinely styled text with no logo image at all.$o$,
  $n$     - THE HEADER LOGO IS THE OPERATOR'S REAL BRAND FILE — IMPORT IT, NEVER REDRAW IT. The `images` facet gave you the source logo's URL. IMPORT it FIRST with `import_media_from_urls({urls:[<logo url>]})` (or bind it once with `set_theme_asset({slot:'logo'})` + reference `{{theme_logo_url}}`; favicon the same way), then reference the returned CAELO media URL in the header — never hotlink the source host, never hand-author the logo as a text/CSS/SVG wordmark (a redrawn logo is a migration defect). The ONLY time a text logo is acceptable is when the source brand itself is genuinely styled text with no logo image at all.$n$
) WHERE slug = 'site-migrate';

-- R3 — ASSETS FIRST, then build with the Caelo URLs directly (no re-host loop).
UPDATE skills SET body = replace(body,
  $o$   - Build the homepage's own content modules + its template (name it e.g. 'Startseite'), following THE REBUILD CONTRACT below — fresh semantic module html carrying ALL of the source content.
   - `migrate_media` so every image the homepage references is Caelo-hosted, never hotlinked from the source host.$o$,
  $n$   - ASSETS FIRST, THEN BUILD. Before authoring the modules, IMPORT the images the homepage will use with `import_media_from_urls({urls:[...]})` — the relevant ones from the `images` facet, BATCHED in one call; it returns the Caelo media URLs. THEN build the homepage's content modules + its template (name it e.g. 'Startseite') following THE REBUILD CONTRACT, referencing those CAELO media URLs DIRECTLY. There is NO re-host pass — never build with source-host URLs "to fix later"; embed the final Caelo URLs from the start, never hotlink the source host.$n$
) WHERE slug = 'site-migrate';

-- R4 — key-type build: drop migrate_media (assets imported before building).
UPDATE skills SET body = replace(body,
  $o$Run `check_page_content_inventory` and `verify_import_page_fidelity` on the representative; `migrate_media`; `log_page_edit`.$o$,
  $n$Import the type's assets first with `import_media_from_urls` and reference the Caelo URLs when building; run `check_page_content_inventory` and `verify_import_page_fidelity` on the representative; `log_page_edit`.$n$
) WHERE slug = 'site-migrate';

-- R5 — mass import: drop migrate_media (assets imported per page before build).
UPDATE skills SET body = replace(body,
  $o$`verify_import_page_fidelity` at least each type's representative plus a spot-check; `migrate_media` so nothing hotlinks the source host. Optionally run a lighter fidelity check across the long tail rather than grading every single page.$o$,
  $n$`verify_import_page_fidelity` at least each type's representative plus a spot-check. Assets are imported (`import_media_from_urls`, or `list_page_assets` to enumerate a crawled page's assets) BEFORE each page is built and embedded as Caelo URLs, so nothing hotlinks the source host. Optionally run a lighter fidelity check across the long tail rather than grading every single page.$n$
) WHERE slug = 'site-migrate';

-- R6 — cross-cutting media rule: import-first, no scan pass, find_media is not for source media.
UPDATE skills SET body = replace(body,
  $o$MEDIA IS A STATE CHECK, not a one-time step (compose may have run in an earlier session, so a trigger phrased as "after compose" never fires): at the START of rebuild work AND again BEFORE reporting the migration done, check whether any page still references source-host media or `migrate_media` has not yet run for this run — if either holds, call `migrate_media` NOW. NEVER report the migration done while any page hotlinks the source host. Relay every skipped asset (url + reason) to the operator VERBATIM; never claim media migrated when the report says skipped.$o$,
  $n$MEDIA — IMPORT FIRST, EMBED FINAL. Source images/fonts/media enter the site ONLY via `import_media_from_urls` (you name the exact URLs — from the inspect `images` facet, or `list_page_assets({runId, search})` to enumerate/search a crawled page's assets), which returns Caelo media URLs you embed DIRECTLY when building. There is NO scan-and-rewrite pass. `find_media` searches the EXISTING Caelo library (empty at the start of a migration) — it is NOT how source media enters, and you never ask the operator to upload source images. BEFORE reporting the migration done, ensure NO built page references a source-host URL; if any does, import those URLs and re-point them. NEVER report done while a page hotlinks the source host; relay every skipped asset (url + reason) VERBATIM.$n$
) WHERE slug = 'site-migrate';

-- R7 — nav-to-intended-slug + narration, appended to THE REBUILD CONTRACT.
UPDATE skills SET body = replace(body,
  $o$   - CHROME IS LAYOUT-OWNED (#253): the header/footer live on the layout, edited via the layout tools — never per page, never inside a page body.$o$,
  $n$   - CHROME IS LAYOUT-OWNED (#253): the header/footer live on the layout, edited via the layout tools — never per page, never inside a page body.
   - LINKS POINT AT THE INTENDED SLUG, NEVER `#`. Nav items and CTAs link to the page's REAL intended slug (from `map_external_page_types`, the site's own paths) even before that page exists — it resolves the moment the page is built, and the stage/publish link-integrity check flags any that stay dead. Use `#` ONLY for a genuinely target-less anchor, never as a placeholder for a real destination.
   - NARRATE EACH STEP. Before a batch of tool calls, say in ONE short sentence what you are about to do ("Ich importiere die Bilder und baue den Header"). Never emit a silent tool-only turn — the operator must always see what is happening.$n$
) WHERE slug = 'site-migrate';

-- R8 — the crawl-approval UX moved from the (now inspect-only) homepage step to
-- the mass-import step (step 5), where the crawl now lives.
UPDATE skills SET body = replace(body,
  $o$in DEPTH mode (same TWO-STEP approve flow) to fetch the remaining same-origin pages.$o$,
  $n$in DEPTH mode to fetch the remaining same-origin pages. It is a TWO-STEP flow: (1) you propose, (2) the operator clicks APPROVE on the proposal card pinned in the "Pending your approval" strip right above the input box — say "hit Approve right above the input box and I'll continue automatically". Never send them to an admin page, and NEVER claim the crawl ran, is running, or succeeded before it did; an automatic "Approved" message arrives after their click, and while status is `crawling` say so in one sentence and continue when it reaches `ready_for_review`.$n$
) WHERE slug = 'site-migrate';

-- R9 — remove the now-redundant old rich-inspect line (R1's live inspect covers
-- screenshot/tokens/images + query_page_html; the old altTexts line duplicated it).
UPDATE skills SET body = replace(body,
  $o$
   - Inspect the homepage sample RICHLY — `inspect_external_page({url, facets:{screenshot:true, tokens:true, altTexts:true}})`: screenshot as the visual reference, tokens for the real palette + typography (never guess a palette the crawl already measured), altTexts for the image inventory. When you need just ONE section of a big page (a pricing table, a specific block) rather than the whole markup, use `query_page_html({pageRef, describe:"the pricing table"})` (natural language — a small model extracts it) or `query_page_html({pageRef, keyword:"..."})`.$o$,
  $n$$n$
) WHERE slug = 'site-migrate';

COMMIT;
