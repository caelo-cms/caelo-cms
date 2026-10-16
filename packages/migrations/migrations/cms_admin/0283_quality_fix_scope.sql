-- SPDX-License-Identifier: MPL-2.0
--
-- 0283 — one "Fix all with AI" fixes until the target.
--
-- #685 made every quality fix round wait for the operator's click on the
-- chat card. With the target at 100 and zero findings (#727) that turned
-- "fix these" into one click per round. Now the operator's "Fix all with AI"
-- carries over: the Live Edit AI's re-Stage of that round continues on its
-- own while each round gets closer to the target, and the card asks again
-- only when a round did not.
--
-- `fix_scope` records what the operator's click asked for, next to the
-- `fix_requested_at` of 0260:
--   all     "Fix all with AI" — every open group; the next round continues
--   picked  some groups / pages ("leave the others alone"); it never does
-- NULL exactly when no fix was requested. Requests from before this
-- migration were all "fix all" or a picked fix; they count as picked, so no
-- old chain starts running on its own.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE quality_audit_runs
  ADD COLUMN fix_scope text NULL CHECK (fix_scope IS NULL OR fix_scope IN ('all', 'picked'));

UPDATE quality_audit_runs SET fix_scope = 'picked' WHERE fix_requested_at IS NOT NULL;

ALTER TABLE quality_audit_runs
  ADD CONSTRAINT quality_audit_runs_fix_scope_requested
    CHECK ((fix_scope IS NULL) = (fix_requested_at IS NULL));

COMMIT;
