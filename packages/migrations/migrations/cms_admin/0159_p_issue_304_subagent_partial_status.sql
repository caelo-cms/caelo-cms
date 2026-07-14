-- SPDX-License-Identifier: MPL-2.0
--
-- 0159 — subagent partial-completion status (issue #304).
--
-- Runs #14/#15: every spawn_subagents child building a page batch spent
-- 90-167M microcents against the old hardcoded 50M cap, errored, and its
-- work was discarded. #304 makes a child that approaches its (now
-- budget-derived) cap finish the current page and submit a PARTIAL result
-- instead: completed pages are saved and the orchestrator re-dispatches
-- the remainder. 'partial' is that finished-but-not-done state on the
-- Owner observability surface — an honest status, not 'completed' with a
-- caveat buried in result_json and not a fake 'errored'.
--
-- The status CHECK was created inline in 0033 (auto-named
-- subagent_runs_status_check); extend it with 'partial'.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE subagent_runs
  DROP CONSTRAINT IF EXISTS subagent_runs_status_check;

ALTER TABLE subagent_runs
  ADD CONSTRAINT subagent_runs_status_check
  CHECK (status IN ('pending','running','completed','partial','errored','timed_out','cancelled'));

COMMIT;
