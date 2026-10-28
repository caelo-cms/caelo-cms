-- SPDX-License-Identifier: MPL-2.0
--
-- 0391 — a bug report says whether it is a defect or a suggestion (#1192).
--
-- The AI filed feature ideas and docs gaps through `bug_report`, and they
-- reached the public tracker as `[ai-detected]` defects, using the daily
-- issue slots meant for bugs. `kind` lets it say which one it files:
--
--   defect     — something in Caelo misbehaved (every auto capture and
--                provider error is one)
--   suggestion — nothing misbehaved; Caelo lacks a capability, a tool or a
--                docs page the AI needed. Filed by the AI only.
--
-- Severity grades defects only, so a suggestion stores none: `severity`
-- loses NOT NULL, and the shape check makes "defect ⇔ severity set" and
-- "suggestion ⇒ source 'ai'" hold for every row.
--
-- Expand-safe: every existing row is a defect (the column default backfills
-- them, the same rule the bug-intake contract applies to a report without
-- a kind), and the previous release's INSERTs name neither column, so they
-- keep writing graded defects. Only the new release writes suggestions.
-- After a rollback to the previous image, a suggestion row (severity NULL)
-- is what that image cannot read: its forwarding worker marks the row
-- `failed` with the reason (per-row, the rest still go out) and its report
-- list does not parse it. Nothing is lost: once the release is back, the
-- Owner's "Send unsent reports" on /settings/bugs sends it again. That is data written by the new release, not a schema
-- break, so this migration is not marked contract.
-- Inherits ai_bug_reports' RLS policies.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE ai_bug_reports
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'defect'
    CHECK (kind IN ('defect', 'suggestion'));

ALTER TABLE ai_bug_reports ALTER COLUMN severity DROP NOT NULL;

ALTER TABLE ai_bug_reports DROP CONSTRAINT IF EXISTS ai_bug_reports_kind_shape;
ALTER TABLE ai_bug_reports
  ADD CONSTRAINT ai_bug_reports_kind_shape CHECK (
    (kind = 'defect') = (severity IS NOT NULL)
    AND (kind = 'defect' OR source = 'ai')
  );

COMMIT;
