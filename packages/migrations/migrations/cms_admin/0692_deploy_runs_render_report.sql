-- SPDX-License-Identifier: MPL-2.0
--
-- 0692 — issue #1604: a Stage never fails on the site's content.
--
-- A staging build that meets a spot it cannot render (a placeholder its
-- field cannot answer, a deleted nested module, a link to a deleted page)
-- no longer stops: it ships that spot as the editor preview shows it and
-- reports the failures, so the AI can repair them. Publish live copies the
-- build as it is, so the refusal has to belong to the build, like #1240's
-- link notice (0653): an audit can fail and a finding can be accepted, but
-- such a build must never go live.
--
-- `deploy_runs.render_report` — what the build could not render: the count,
-- the first failures in their structure (page, block, module, field,
-- marker) and the texts for the operator and the AI
-- (deploy/render-failures.ts). NULL on a run without any, and on every run
-- from before this column: such a build stopped on a render failure.
--
-- Expand-only: one nullable column, read only by the release that writes it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs ADD COLUMN render_report jsonb NULL
  CHECK (render_report IS NULL OR jsonb_typeof(render_report) = 'object');

COMMIT;
