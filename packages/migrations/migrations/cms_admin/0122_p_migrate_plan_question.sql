-- SPDX-License-Identifier: MPL-2.0
--
-- 0122 — site-migrate: one plan question BEFORE queueing the crawl.
-- Live operator feedback (2026-07-12): the AI pitched the plan,
-- mentioned a pilot alternative, and queued the full crawl in the
-- SAME message — the operator never got to answer. And the "card
-- above" phrasing pointed at a card that had already scrolled away
-- ("missed it nearly"); the pending strip is now pinned above the
-- chat input, so the skill points there.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  '4. PROPOSE THE CRAWL — `propose_site_import({sourceUrl, depth, maxPages})`, sized from the inspection (sitemap count when present; generous depth for link-only sites). This is a TWO-STEP flow: (1) you propose, (2) the operator clicks the APPROVE BUTTON ON THE PROPOSAL CARD that appears right here in the chat. Say exactly that — "I''ve prepared the crawl; click Approve on the card above and I''ll continue automatically" — never send them to an admin page, and NEVER claim the crawl ran, is running, or succeeded before it did. After their click you receive an automatic "Approved" message; the crawl then runs in the BACKGROUND (~a minute for small sites): check `imports.get`, and while status is still `crawling`, say so in one sentence and continue the moment it reaches `ready_for_review` (the operator can also just ask "fertig?"). State the expected scope in plain words ("looks like roughly N pages") so the approval is informed; for large sites (hundreds of pages) add that the rebuild will take real time and AI budget, and offer a bounded pilot (homepage + one section) as the alternative.',
  '4. PLAN CHECK — after the operator answers the design fork, ask exactly ONE more question that combines plan-ok and scope: recap the crawl in one line ("~N pages per the sitemap, both languages, a couple of minutes in the background, modest AI budget") and ask whether to take EVERYTHING or start with a bounded pilot (homepage + one section, ~20 pages). WAIT for the answer — never queue a proposal in the same message that pitches the plan.
5. PROPOSE THE CRAWL — `propose_site_import({sourceUrl, depth, maxPages})` sized to their step-4 choice. This is a TWO-STEP flow: (1) you propose, (2) the operator clicks APPROVE on the proposal card — it is also pinned in the "Pending your approval" strip right above the chat input, so say exactly that: "I''ve prepared the crawl; hit Approve right above the input box and I''ll continue automatically". Never send them to an admin page, and NEVER claim the crawl ran, is running, or succeeded before it did. After their click you receive an automatic "Approved" message; the crawl then runs in the BACKGROUND (~a minute for small sites): check `imports.get`, and while status is still `crawling`, say so in one sentence and continue the moment it reaches `ready_for_review` (the operator can also just ask "fertig?").'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%4. PROPOSE THE CRAWL%';

-- Keep the numbered references downstream of the inserted step in sync.
UPDATE skills
SET body = replace(
  body,
  '5. AFTER THE CRAWL (status ready_for_review) — route by the operator''s step-3 answer:',
  '6. AFTER THE CRAWL (status ready_for_review) — route by the operator''s step-3 answer:'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%5. AFTER THE CRAWL%';

UPDATE skills
SET body = replace(
  body,
  '6. PRESENT — show the operator what was built',
  '7. PRESENT — show the operator what was built'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%6. PRESENT — show the operator what was built%'
  AND body LIKE '%6. AFTER THE CRAWL%';

COMMIT;
