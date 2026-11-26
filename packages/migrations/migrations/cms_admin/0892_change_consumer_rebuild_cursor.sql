-- SPDX-License-Identifier: MPL-2.0
--
-- 0892 (written as 0800; renumbered above v0.12.17's 0885 so upgraded and fresh installs apply it in the same order) — issue #1729 (decision Q11): a change consumer's rebuild runs in
-- resumable chunks. A rebuild operation answers `{ done: false, cursor }`
-- for "more to do, start the next chunk here"; the host keeps that cursor
-- on the consumer, so the rebuild resumes at the next drain (another tick,
-- another instance) instead of having to recompute a 50 000-page site in
-- one sandbox call (docs/dev/external-plugin-brokers.md §5.2).
--
-- The cursor is the plugin's opaque text. It exists only while a rebuild
-- is pending: beginning a rebuild clears it, finishing one clears it with
-- the pending flag in the same statement. Additive and nullable, so the
-- previous admin image keeps working during the roll.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE change_consumers
  ADD COLUMN IF NOT EXISTS rebuild_cursor text NULL;

ALTER TABLE change_consumers DROP CONSTRAINT IF EXISTS change_consumers_rebuild_cursor_check;
ALTER TABLE change_consumers
  ADD CONSTRAINT change_consumers_rebuild_cursor_check
  CHECK (rebuild_cursor IS NULL OR (rebuild_pending AND length(rebuild_cursor) BETWEEN 1 AND 4096));

COMMIT;
