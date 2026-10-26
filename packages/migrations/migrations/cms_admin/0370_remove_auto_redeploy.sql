-- SPDX-License-Identifier: MPL-2.0
-- caelo:contract the previous image's redeploy orchestrator, gateway settings ops and AI Stage merges read and write the dropped columns and table
--
-- 0370 — issue #1154: the automatic redeploy is removed from core.
-- Nothing reaches production except through a human Publish live (or an
-- Owner-initiated production build); deploy.trigger / deploy.promote refuse
-- every non-human production request.
--
-- Dropped, because nothing reads or writes them any more:
--
--   site_settings.auto_redeploy_enabled / _debounce_ms / _op_kinds (0038)
--     the Owner's auto-redeploy switch, its debounce and its op allowlist;
--   site_settings.auto_redeploy_last_seen_at (0041)
--     the orchestrator's audit_events watermark;
--   site_settings.auto_redeploy_last_public_event_id (0281)
--     its watermark in cms_public.gateway_plugin_op_events (the table
--     itself stays: the gateway still records visitor plugin op events,
--     and #1155 decides what reads them);
--   quality_audit_runs.auto_publish / _outcome / _message (0243)
--     the audit-gated automatic publish of an automatic Stage;
--   ai_stage_holds + deploy_runs.covered_ai_hold_ids (0246)
--     the hold that kept automatic production publishes from shipping an
--     AI Stage. With no automatic publish left there is nothing to hold:
--     production is built only for a human, who IS the decision the hold
--     waited for.
--
-- A pending gateway-settings proposal that still names an auto-redeploy
-- field could never apply (the apply step's schema no longer has it), so
-- it is superseded with the reason instead of failing at the Approve click.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE owner_settings_pending_actions
   SET status = 'superseded',
       decided_at = now(),
       decision_reason = 'the automatic redeploy was removed (#1154); propose the remaining gateway settings again'
 WHERE status = 'pending'
   AND kind = 'set_gateway_settings'
   AND payload ?| ARRAY['autoRedeployEnabled', 'autoRedeployDebounceMs', 'autoRedeployOpKinds'];

ALTER TABLE site_settings
  DROP COLUMN auto_redeploy_enabled,
  DROP COLUMN auto_redeploy_debounce_ms,
  DROP COLUMN auto_redeploy_op_kinds,
  DROP COLUMN auto_redeploy_last_seen_at,
  DROP COLUMN auto_redeploy_last_public_event_id;

ALTER TABLE quality_audit_runs DROP CONSTRAINT quality_audit_runs_auto_publish_shape;
ALTER TABLE quality_audit_runs
  DROP COLUMN auto_publish,
  DROP COLUMN auto_publish_outcome,
  DROP COLUMN auto_publish_message;

ALTER TABLE deploy_runs DROP COLUMN covered_ai_hold_ids;
DROP TABLE ai_stage_holds;

COMMIT;
