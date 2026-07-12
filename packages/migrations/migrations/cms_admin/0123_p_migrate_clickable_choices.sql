-- SPDX-License-Identifier: MPL-2.0
--
-- 0123 — site-migrate: URL-only opener + clickable choices.
-- Live operator feedback (2026-07-12), two findings on the same run:
--   1. "fragt jetzt am anfang zu viel" — the opener previewed BOTH
--      later decisions (design fork, scope) in prose before even
--      having the URL. The opener now asks ONLY for the URL.
--   2. "i need to answer with a or b insted i can click" — the fork
--      and scope questions now go through the new `offer_choices`
--      tool, which the chat renders as buttons.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- (1) URL-only opener as step 0.
UPDATE skills
SET body = replace(
  body,
  'Workflow:
1. INSPECT',
  'Workflow:
0. NO URL YET — ask ONLY for the URL, one short sentence ("What''s the URL of your current website?"). Do NOT preview the later decisions; design and scope come later, one at a time, each as clickable choices.
1. INSPECT'
)
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%0. NO URL YET%';

-- (2) Design fork via offer_choices, sized as "how much redesign".
UPDATE skills
SET body = replace(
  body,
  '3. FORK — ask exactly ONE question: keep the current design, or take the move as the chance for a redesign? Give your one-sentence recommendation based on what you saw. Do not ask anything else in the same message.',
  '3. FORK — one decision, asked via `offer_choices` (the chat renders BUTTONS; never ask the operator to type A or B): question "How much redesign do you want while we migrate?", options A) Keep the design as-is, B) Light refresh — keep the brand colors, modernise typography/spacing/polish, C) Full redesign — new direction, your content stays. Give your one-sentence recommendation in the same message BEFORE the tool call. Ask nothing else in this turn.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%3. FORK — ask exactly ONE question%';

-- (3) Plan check via offer_choices.
UPDATE skills
SET body = replace(
  body,
  '4. PLAN CHECK — after the operator answers the design fork, ask exactly ONE more question that combines plan-ok and scope: recap the crawl in one line ("~N pages per the sitemap, both languages, a couple of minutes in the background, modest AI budget") and ask whether to take EVERYTHING or start with a bounded pilot (homepage + one section, ~20 pages). WAIT for the answer — never queue a proposal in the same message that pitches the plan.',
  '4. PLAN CHECK — after the fork answer, recap the crawl in one line ("~N pages per the sitemap, both languages, a couple of minutes in the background, modest AI budget") and ask the scope via `offer_choices`: question "How much should we crawl?", options A) Full site — everything the sitemap exposes, B) Pilot first — homepage + one section (~20 pages), see the rebuild before committing. WAIT for the answer — never queue a proposal in the same message that pitches the plan.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%4. PLAN CHECK — after the operator answers the design fork%';

COMMIT;
