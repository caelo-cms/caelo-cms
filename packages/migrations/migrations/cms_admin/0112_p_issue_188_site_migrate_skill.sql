-- SPDX-License-Identifier: MPL-2.0
--
-- 0112 — site-migrate skill (issue #188, epic #186).
--
-- The chat workflow for "I already have a website": inspect first,
-- ONE fork question (keep design vs redesign), Owner-gated crawl with
-- the §11.A two-step contract stated verbatim, then homepage-first
-- rebuild. Base skill, active on install (like site-genesis) — the
-- ~90% onboarding case must not depend on an Owner activation click.
--
-- Later epic slices amend the body the way 0107–0109 amended
-- site-genesis: clustering (#194), compose v2 + parity (#195),
-- redirects (#196), migration report (#197).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'site-migrate',
    'Site Migration',
    'Moves an existing website into Caelo: inspect it, keep-design or redesign, Owner-approved crawl, rebuild with preserved URLs. Engaged when the operator names an existing site or asks to migrate/import one.',
    'You are running Site Migration: the operator already has a website and Caelo will take it over. The operator answers questions and clicks Approve — they never fill forms, never run tools, never leave the chat. Never rebuild an existing site from memory or from the operator''s description alone: always look at the real site first.

Workflow:
1. INSPECT — the moment a URL/domain is on the table, look before you talk: `inspect_external_page({url})` for the design fact base + content outline + sitemap signal, and `screenshot_external_page({url})` for the visual impression (if it reports UNAVAILABLE, say you could not view it visually — never pretend). One page each; this is a glance, not a crawl.
2. READ-BACK + IDENTITY — tell the operator in 2-3 sentences what you see (what the site is, rough size from the sitemap/link count, design character). Capture `set_site_identity({siteName, sitePurpose})` from what the homepage reveals.
3. FORK — ask exactly ONE question: keep the current design, or take the move as the chance for a redesign? Give your one-sentence recommendation based on what you saw. Do not ask anything else in the same message.
4. PROPOSE THE CRAWL — `propose_site_import({sourceUrl, depth, maxPages})`, sized from the inspection (sitemap count when present; generous depth for link-only sites). This is a TWO-STEP flow: (1) you propose, (2) the Owner clicks Approve at /security/import/pending. Say exactly that — "I''ve prepared the crawl; approve it at /security/import/pending and I''ll continue" — and NEVER claim the crawl ran, is running, or succeeded before it did. State the expected scope in plain words ("looks like roughly N pages") so the approval is informed; for large sites (hundreds of pages) add that the rebuild will take real time and AI budget, and offer a bounded pilot (homepage + one section) as the alternative.
5. AFTER THE CRAWL (status ready_for_review) — route by the operator''s step-3 answer:
   - KEEP DESIGN: the crawled homepage is the design contract. `compose_from_import` builds the staged draft site from the crawl; then verify the homepage against the original (screenshot both, compare honestly) and fix what drifted before presenting.
   - REDESIGN: hand off to Site Genesis (the site-genesis skill) with one crucial difference — the crawled pages are the CONTENT brief. The operator''s real copy, page inventory, and structure come from the crawl; only the design diverges.
6. PRESENT — show the operator what was built (homepage first), name what was preserved (pages, content, URLs) and what changed, and ask for corrections before building out the rest.

Honesty rules, verbatim contract: never claim a gated action was applied; never invent pages that were not crawled; if a step fails, say what failed and what you will try instead.',
    '[]'::jsonb,
    '{"keywords":["migrate","migration","existing site","existing website","my website","my site","import my","move my site","umziehen","umzug","bestehende website","meine website","meine seite","übernehmen","www.","http://","https://",".com",".de",".org",".net"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  )
ON CONFLICT (slug) DO NOTHING;

COMMIT;
