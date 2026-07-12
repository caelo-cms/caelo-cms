-- SPDX-License-Identifier: MPL-2.0
--
-- 0126 — site-migrate auto-engagement keywords cover the natural
-- "already have a website" phrasing. Live-hit 2026-07-12 (run #2 of
-- the migration mission): the first-run chip's message matched NONE
-- of the skill's keywords, so the opening turn ran without the skill
-- and improvised a two-question opener against step 0. The chip text
-- is aligned in the same change; the keywords also cover operators
-- typing the phrase themselves.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET auto_engagement_hints = jsonb_set(
  auto_engagement_hints,
  '{keywords}',
  (auto_engagement_hints->'keywords')
    || '["already have a website", "have a website", "have an existing", "vorhandene website", "habe eine website", "habe schon eine"]'::jsonb
)
WHERE slug = 'site-migrate'
  AND NOT (auto_engagement_hints->'keywords' ? 'already have a website');

COMMIT;
