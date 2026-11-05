-- SPDX-License-Identifier: MPL-2.0
--
-- 0653 — issue #1240: Publish live refuses a Stage whose build links a page
-- with no version in the linking page's language.
--
-- A staging build renders such a link to the target in its own language, so
-- the staged site stays clickable for review. Publish live copies that build
-- as it is, so the refusal has to belong to the build: an audit can be
-- skipped and a finding can be accepted, but these links must never go live.
--
-- `deploy_runs.link_notice` — what the build shipped of them, as the operator
-- and the AI read it (links/link-notice.ts). NULL on a run without any, and
-- on every run from before this column: the build then refused such a link.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs ADD COLUMN link_notice jsonb NULL
  CHECK (link_notice IS NULL OR jsonb_typeof(link_notice) = 'object');

COMMIT;
