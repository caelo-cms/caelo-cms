-- SPDX-License-Identifier: MPL-2.0
--
-- 0276 — issue #727, maintainer decision 2026-10-14: "optimum, not good
-- enough". The quality gate targets 100 and zero findings, blocks every
-- finding until it is fixed or an editor accepts it, and grandfathers
-- nothing.
--
--   quality_audit_runs.gate_rules   the gate rules an audit was recorded
--                                   under. Existing rows are 1 (the #553
--                                   rules: audits at >= 0.9 passed, scores
--                                   were compared with per-page baselines);
--                                   new rows default to 2 (target 100,
--                                   every audit below 1 a finding, no
--                                   baselines). The gate does not trust a
--                                   rules-1 verdict: the staged build must
--                                   be checked again before Publish live.
--   quality_acceptances.accepted_score on kind 'finding'
--                                   a Lighthouse finding acceptance now
--                                   records the audit score it accepted
--                                   (0..100 points), so a worse score
--                                   blocks again. Existing finding
--                                   acceptances are backfilled from the
--                                   audit they were made from; one whose
--                                   measurement is gone keeps NULL and
--                                   covers its audit as recorded.
--   quality_baselines               retired. Nothing reads or writes it any
--                                   more. Its rows are deliberately NOT
--                                   turned into acceptances: a baseline
--                                   below 100 was the ratchet's memory,
--                                   never an editor's decision, and turning
--                                   it into one would grandfather exactly
--                                   the debt this decision ends. The table
--                                   stays until a later contract release
--                                   drops it.
--
-- UPGRADE IMPACT: existing debt (scores below 100, audits between 0.9 and
-- 1, anything a baseline below 100 let pass) shows up as blocking findings
-- on the next quality check. The staged build's current audit is
-- rules-1, so Publish live asks for a new check first.
--
-- Expand-only (#696): a new column with a default, a widened CHECK and a
-- data backfill of a nullable value. The previous image reads and writes
-- every table as before (it never reads gate_rules, and the finding CHECK
-- still admits its NULL accepted_score).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- Existing runs get 1, then the default moves to 2 for every new run.
ALTER TABLE quality_audit_runs
  ADD COLUMN gate_rules smallint NOT NULL DEFAULT 1 CHECK (gate_rules >= 1);
ALTER TABLE quality_audit_runs ALTER COLUMN gate_rules SET DEFAULT 2;

ALTER TABLE quality_acceptances DROP CONSTRAINT quality_acceptances_check;
ALTER TABLE quality_acceptances
  ADD CONSTRAINT quality_acceptances_check CHECK (
    (kind = 'finding' AND audit_id IS NOT NULL AND category IS NULL AND accepted_count IS NULL)
    OR (kind = 'score' AND audit_id IS NULL AND category IS NOT NULL AND accepted_score IS NOT NULL
       AND accepted_count IS NULL)
    OR (kind = 'check' AND audit_id IS NOT NULL AND category IS NULL AND accepted_score IS NULL
       AND accepted_count IS NOT NULL)
  );

-- The score of the accepted audit on its page, as measured by the audit
-- the acceptance was made from.
UPDATE quality_acceptances a
   SET accepted_score = sub.points
  FROM (
    SELECT a2.id, round((fa->>'score')::numeric * 100)::integer AS points
      FROM quality_acceptances a2
      JOIN quality_audit_pages qp
        ON qp.audit_run_id = a2.audit_run_id AND qp.page_id = a2.page_id
      CROSS JOIN LATERAL jsonb_array_elements(qp.failing_audits) AS fa
     WHERE a2.kind = 'finding' AND a2.accepted_score IS NULL AND fa->>'id' = a2.audit_id
  ) AS sub
 WHERE a.id = sub.id;

COMMENT ON TABLE quality_baselines IS
  'Retired by 0276 (#727): the gate targets 100 without per-page baselines. Kept for the previous image until a contract release drops it.';

COMMIT;
