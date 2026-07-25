-- SPDX-License-Identifier: MPL-2.0
--
-- 0189 — site-migrate skill: drop the screenshot-diff fidelity gate; check
-- correctness by content + visual self-check; sub-pages mirror the homepage
-- workflow.
--
-- `verify_import_page_fidelity` was removed (a pixel/structural diff against
-- the source grades "how close to the original", which is meaningless for a
-- refresh/optimize direction and brittle even for 1:1 — a one-line reflow
-- cascades into a large delta → false fail). Correctness is now:
--   (a) CONTENT — `check_page_content_inventory` (reflow-immune completeness);
--   (b) VISUAL — the AI compares the source screenshot to its own render.
-- And the crawler now yields the same shape as live-inspect (Markdown +
-- screenshot + tokens + assets), just persisted, so each sub-page follows the
-- SAME loop as the homepage, only simpler (modules/theme/chrome already exist).
--
-- Surgical replace()s on the 0178/0187 body, idempotent by distinctive
-- substring (a replace of an already-absent string is a no-op).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- S1 — step 3 checkpoint: content + visual self-check instead of the pixel diff.
UPDATE skills SET body = replace(body,
  $o$   - Run `verify_import_page_fidelity` on the homepage: it structurally diffs the stored source screenshot against a fresh render of your rebuild and returns pass (≤12%) / warn (≤25%) / fail (>25%) plus which region drifted most (header/hero, main content, footer). The verdict comes back IN the tool result (numbers, not a deferred image) — act on it in the SAME turn. This is your "habe ich das gut gemacht?" self-analysis.
   - On warn/fail: LOOK at the source with `get_import_page_screenshot`, fix the named region, and re-check — HARD CAP two repair rounds. A page with no stored source screenshot comes back UNVERIFIED — say so plainly; never claim it matches.$o$,
  $n$   - SELF-CHECK the homepage two ways — there is NO pixel diff (a reflow shifts every pixel below it, so a diff false-fails a faithful 1:1 AND punishes an intended refresh). (a) CONTENT: run `check_page_content_inventory` — every heading, paragraph, list item, image and link from the source must be present in the rebuild. (b) VISUAL: LOOK at the source with `get_import_page_screenshot` and compare it to your rebuilt page's render — does it read as the same site (for a 1:1) or the same brand done better (for a refresh/optimize)? This is your "habe ich das gut gemacht?" self-analysis.
   - If content is missing or the visual is off, fix it and re-check — HARD CAP two repair rounds, then name honestly what still differs; never claim it matches when it does not.$n$
) WHERE slug = 'site-migrate';

-- S2 — step 4 representative: content-inventory + visual self-check, no fidelity.
UPDATE skills SET body = replace(body,
  $o$run `check_page_content_inventory` and `verify_import_page_fidelity` on the representative; `log_page_edit`.$o$,
  $n$run `check_page_content_inventory` on the representative and visually self-check it against `get_import_page_screenshot`; `log_page_edit`.$n$
) WHERE slug = 'site-migrate';

-- S3 — step 5 mass import: content gate + visual spot-check, no fidelity grading.
UPDATE skills SET body = replace(body,
  $o$   - AFTER each rebuilt page run `check_page_content_inventory`; `verify_import_page_fidelity` at least each type's representative plus a spot-check. Assets are imported (`import_media_from_urls`, or `list_page_assets` to enumerate a crawled page's assets) BEFORE each page is built and embedded as Caelo URLs, so nothing hotlinks the source host. Optionally run a lighter fidelity check across the long tail rather than grading every single page.$o$,
  $n$   - AFTER each rebuilt page run `check_page_content_inventory` (content completeness is the gate) and, for at least each type's representative plus a spot-check, a VISUAL self-check against `get_import_page_screenshot`. Assets are imported (`import_media_from_urls`, or `list_page_assets` to enumerate a crawled page's assets) BEFORE each page is built and embedded as Caelo URLs, so nothing hotlinks the source host.$n$
) WHERE slug = 'site-migrate';

-- S4 — sub-pages mirror the homepage workflow (appended to the REUSE-chrome line).
UPDATE skills SET body = replace(body,
  $o$   - REUSE the chrome — the layout header/footer already exist; do NOT rebuild them per type.$o$,
  $n$   - REUSE the chrome — the layout header/footer already exist; do NOT rebuild them per type. SUB-PAGES FOLLOW THE HOMEPAGE WORKFLOW, just simpler: the modules, theme and chrome already exist, so each page is read (its persisted source — the crawl now yields the same shape as live-inspect: Markdown + screenshot + tokens + assets) → its assets imported → rebuilt reusing the built patterns → checked the SAME two ways as the homepage (content-inventory + visual self-check). No separate verification gate.$n$
) WHERE slug = 'site-migrate';

COMMIT;
