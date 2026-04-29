-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 9 review pass — align `pages.translation_status` with
-- CMS_REQUIREMENTS §7.5: {source, up_to_date, needs_update, not_started}.
--
-- 0029_p9_i18n.sql shipped the enum as {source, fresh, stale}, which
-- diverges from the spec on naming and is missing `not_started`.
-- Mode-1 vs Mode-2 dispatch (§7.6) keys off the not-started state,
-- and the translation dashboard UI (§7.7) renders "○ not started"
-- from this exact value. P10 (AI translation) needs the right
-- vocabulary — fix it before P10 builds on top.
--
-- `not_started` is a virtual state synthesised by the dashboard
-- query when a target locale has no row at all; it isn't stored in
-- this column. The CHECK still allows it for forward-compat (e.g.
-- a placeholder row created by a Mode-1 prep step).

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_translation_status_check;

UPDATE pages SET translation_status = 'up_to_date'   WHERE translation_status = 'fresh';
UPDATE pages SET translation_status = 'needs_update' WHERE translation_status = 'stale';

ALTER TABLE pages ADD CONSTRAINT pages_translation_status_check
  CHECK (translation_status IN ('source', 'up_to_date', 'needs_update', 'not_started'));
