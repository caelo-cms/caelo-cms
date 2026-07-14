-- SPDX-License-Identifier: MPL-2.0
--
-- 0137 — site-migrate: measured fidelity gate (issue #250 / WS4).
--
-- Nothing forced the migration to LOOK at its own output: broken subpages
-- shipped because "looks done" was never turned into "measured done". WS4
-- adds `verify_import_page_fidelity`, which diffs a page's stored source
-- screenshot against a fresh render of the rebuild and returns pass/warn/fail
-- synchronously. This teaches the skill WHEN to call it: the homepage
-- self-analysis checkpoint (#278's authoritative flow, step 3) and per page
-- type before fanning out — and to never report the migration done while any
-- graded page reads warn/fail.
--
-- Guarded + idempotent like 0130-0136: appends once, no-ops when its marker
-- text is already present.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = body || '

MEASURE FIDELITY, DO NOT VIBE-CHECK: after you rebuild an imported page, prove it matches the original with `verify_import_page_fidelity` — it structurally diffs the stored source screenshot against a fresh render of your rebuild and returns pass (≤12%) / warn (≤25%) / fail (>25%) plus which region drifted most (header/hero, main content, footer). The verdict comes back IN the tool result (numbers, not a deferred image), so act on it in the same turn. This is your "habe ich das gut gemacht?" self-analysis — the homepage checkpoint depends on it: build the homepage FIRST, run verify_import_page_fidelity on it, and only present the direction to the operator ("so sieht deine Startseite aus — passt die Richtung?") once it reads PASS (or you have named honestly what still differs). On warn/fail, LOOK at the source with get_import_page_screenshot, fix the named region, and re-check — HARD CAP two repair rounds. Then, as you fan out per page type, grade each rebuilt type the same way. A page with no stored source screenshot comes back UNVERIFIED — say so plainly; never claim it matches. When you close with get_import_run_report, its fidelity rollup lists every over-threshold page: NEVER say "fertig" while a page reads warn or fail — name those pages to the operator instead.'
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%MEASURE FIDELITY%';

COMMIT;
