-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.42 — extend plugin_rate_limit_proposals.status CHECK to include
-- 'superseded' (and 'cancelled', for parity with the 11 unified-shape
-- *_pending_actions tables that v0.2.35 widened). The proposal-GC
-- worker (v0.2.37) skipped this table previously because its CHECK
-- was limited to ('pending', 'applied', 'rejected'). After this
-- migration it can sweep stale rate-limit proposals alongside the
-- rest.
--
-- Note: a permission pre-flight (`caelo_someone_has_permission`) was
-- attempted alongside this migration but the GUC plumbing required
-- a Postgres role + custom-GUC config we don't currently provision.
-- Reverted; the SvelteKit route guard catches "operator can't
-- approve" at execute time anyway. May revisit when the provisioner
-- lands the role-config knob.

ALTER TABLE plugin_rate_limit_proposals
  DROP CONSTRAINT IF EXISTS plugin_rate_limit_proposals_status_check;
ALTER TABLE plugin_rate_limit_proposals
  ADD CONSTRAINT plugin_rate_limit_proposals_status_check
  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled'));
