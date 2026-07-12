-- SPDX-License-Identifier: MPL-2.0
--
-- 0121 — chat-first approval wording (operator feedback on the live
-- migrate flow: "hier haben wir einen Bruch im User-Flow — alles soll
-- im Chat-Kontext stattfinden"). The proposal CARD in the chat carries
-- the Approve button; the skill must point there, never at an admin
-- page. Also: the crawl runs in the background after the click — the
-- skill now says how to behave while it runs.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- Replace the step-4 sentence that sent operators to the admin page.
UPDATE skills
SET body = replace(
  body,
  'This is a TWO-STEP flow: (1) you propose, (2) the Owner clicks Approve at /security/import/pending. Say exactly that — "I''ve prepared the crawl; approve it at /security/import/pending and I''ll continue" — and NEVER claim the crawl ran, is running, or succeeded before it did.',
  'This is a TWO-STEP flow: (1) you propose, (2) the operator clicks the APPROVE BUTTON ON THE PROPOSAL CARD that appears right here in the chat. Say exactly that — "I''ve prepared the crawl; click Approve on the card above and I''ll continue automatically" — never send them to an admin page, and NEVER claim the crawl ran, is running, or succeeded before it did. After their click you receive an automatic "Approved" message; the crawl then runs in the BACKGROUND (~a minute for small sites): check `imports.get`, and while status is still `crawling`, say so in one sentence and continue the moment it reaches `ready_for_review` (the operator can also just ask "fertig?").'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%approve it at /security/import/pending%';

COMMIT;
