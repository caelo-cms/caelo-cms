-- SPDX-License-Identifier: MPL-2.0
--
-- 0475 — RLS setting tests the planner estimates as "passes" (issue #1297).
--
-- Root cause. Postgres keeps a policy's quals at the scan they protect:
-- `process_security_barrier_quals` (initsplan.c) distributes them with
-- `ojscope = qualscope`, so a policy term without column references — e.g.
-- `current_setting('caelo.actor_kind', true) = 'system'` — is NOT marked
-- pseudoconstant like the same term in a WHERE clause would be. A
-- pseudoconstant qual becomes a one-time filter with selectivity 1.0; the
-- policy term instead stays a row filter and is estimated like one. With no
-- statistics on either side the estimators fall back to their defaults:
--
--   setting = 'x'               DEFAULT_EQ_SEL       0.5 % of the rows
--   setting = ANY (ARRAY[3])    3 × DEFAULT_EQ_SEL   ~1.5 %
--   NULLIF(setting, '') IS NOT NULL                  99.5 %
--
-- At run time such a term is the same for every row of the statement (all
-- rows pass or none do), so the 0.5 % is a 200× underestimate of every read
-- the policy passes. It turned an unfiltered `ORDER BY … LIMIT` of a plugin
-- table into a full scan + top-N sort (the plugin policy has this shape,
-- PR #1296) and makes every core table guarded this way look 200× smaller
-- to the planner when it picks join orders and nested loops.
--
-- `(SELECT current_setting(...)) = 'x'` does not help (an InitPlan Param is
-- still a non-Var operand: 0.5 %). The NullTest default does: the estimator
-- assumes a Var-free expression IS NOT NULL for 99.5 % of the rows. So the
-- two helpers below return `NULLIF(<comparison>, false) IS NOT NULL`, which
-- is TRUE exactly when the comparison is TRUE and FALSE when it is FALSE or
-- NULL (setting missing) — fail-closed, same truth table as before, never
-- NULL. They are plain LANGUAGE sql STABLE functions without SET clauses,
-- so the planner inlines them into the policy and estimates the inlined
-- NullTest (EXPLAIN shows the expanded expression). No superuser feature is
-- involved: this works on Cloud SQL as on self-hosted Postgres.
--
-- What does NOT change: who sees which row. Every policy below keeps its
-- roles, command, permissive/restrictive kind and its exact logic; only the
-- Var-free `current_setting(...) = literal` / `= ANY (literals)` terms are
-- spelled through the helpers. Comparisons against a column
-- (`plugin_id::text = current_setting(...)`) stay: the planner estimates
-- those from the column's statistics. `migrations/src/rls-planner.
-- integration.test.ts` refuses any policy that spells such a term the old
-- way, so a new migration cannot bring the skew back.
--
-- The plugin tables' own policies are emitted by plugin-sandbox's schema
-- emitter, which uses `caelo_setting_is` from this release on; the changed
-- DDL changes each plugin schema's digest, so every plugin schema is
-- re-provisioned (policy rewritten) the next time its plugin loads.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE OR REPLACE FUNCTION caelo_setting_is(setting text, expected text)
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting(setting, true) = expected, false) IS NOT NULL $$;

COMMENT ON FUNCTION caelo_setting_is(text, text) IS
  'RLS: the session setting equals expected (missing setting = false). Inlined by the planner and estimated as 99.5 % of rows instead of the 0.5 % a Var-free equality gets (#1297).';

CREATE OR REPLACE FUNCTION caelo_setting_in(setting text, expected text[])
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting(setting, true) = ANY (expected), false) IS NOT NULL $$;

COMMENT ON FUNCTION caelo_setting_in(text, text[]) IS
  'RLS: the session setting is one of expected (missing setting = false). Inlined by the planner and estimated as 99.5 % of rows instead of n × 0.5 % (#1297).';

ALTER POLICY ai_budgets_authed ON ai_budgets
  USING ((NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL))
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])));

ALTER POLICY ai_pricing_authed ON ai_pricing
  USING ((NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL))
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])));

ALTER POLICY change_consumers_scope ON change_consumers
  USING (((caelo_setting_is('caelo.actor_kind', 'system')) OR ((plugin_id IS NOT NULL) AND (current_setting('caelo.plugin_id', true) = (plugin_id)::text))))
  WITH CHECK (((caelo_setting_is('caelo.actor_kind', 'system')) OR ((plugin_id IS NOT NULL) AND (current_setting('caelo.plugin_id', true) = (plugin_id)::text))));

ALTER POLICY chat_tool_results_kept_call_owner ON chat_tool_results
  USING (((args IS NULL) OR (args_actor_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))))
  WITH CHECK (((args IS NULL) OR (args_actor_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))));

ALTER POLICY credential_handoffs_recipient_or_system ON credential_handoffs
  USING (((caelo_setting_is('caelo.actor_kind', 'system')) OR ((caelo_setting_is('caelo.actor_kind', 'human')) AND (recipient_actor_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid))))
  WITH CHECK (((caelo_setting_is('caelo.actor_kind', 'system')) OR ((caelo_setting_is('caelo.actor_kind', 'human')) AND (recipient_actor_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid))));

ALTER POLICY domain_events_rw ON domain_events
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['system', 'plugin'])))
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system', 'plugin'])));

ALTER POLICY entity_change_horizons_gc ON entity_change_horizons
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY entity_changes_gc ON entity_changes
  USING ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY entity_changes_merge ON entity_changes
  USING (((xid = pg_current_xact_id()) OR (caelo_setting_is('caelo.actor_kind', 'system'))))
  WITH CHECK ((xid = pg_current_xact_id()));

ALTER POLICY entity_leases_per_actor_scope ON entity_leases
  USING (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) OR ((caelo_setting_in('caelo.actor_kind', ARRAY['ai', 'plugin'])) AND ((branch_id = (NULLIF(current_setting('caelo.chat_branch_id', true), ''))::uuid) OR (holder_key = NULLIF(current_setting('caelo.chat_task_id', true), ''))))))
  WITH CHECK (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) OR ((caelo_setting_in('caelo.actor_kind', ARRAY['ai', 'plugin'])) AND ((branch_id = (NULLIF(current_setting('caelo.chat_branch_id', true), ''))::uuid) OR (holder_key = NULLIF(current_setting('caelo.chat_task_id', true), ''))))));

ALTER POLICY font_assets_insert ON font_assets
  WITH CHECK (((created_by = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) AND (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system']))));

ALTER POLICY font_assets_read ON font_assets
  USING (((NULLIF(current_setting('caelo.actor_id', true), '') IS NOT NULL) AND (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system']))));

ALTER POLICY image_requests_host ON image_requests
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY mcp_remote_access_blocks_delete ON mcp_remote_access_blocks
  USING (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) AND caelo_mcp_tokens_manage_all()));

ALTER POLICY mcp_remote_access_blocks_insert ON mcp_remote_access_blocks
  WITH CHECK (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) AND caelo_mcp_tokens_manage_all()));

ALTER POLICY mcp_remote_connections_insert ON mcp_remote_connections
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY mcp_remote_connections_update ON mcp_remote_connections
  USING (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) AND caelo_mcp_tokens_manage_all()))
  WITH CHECK (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) AND caelo_mcp_tokens_manage_all()));

ALTER POLICY mcp_tokens_delete ON mcp_tokens
  USING (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) AND (caelo_mcp_tokens_manage_all() OR (actor_id = caelo_mcp_token_principal()))));

ALTER POLICY mcp_tokens_insert ON mcp_tokens
  WITH CHECK (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) AND (caelo_mcp_tokens_manage_all() OR (actor_id = caelo_mcp_token_principal()))));

ALTER POLICY mcp_tokens_update ON mcp_tokens
  USING ((caelo_mcp_tokens_manage_all() OR (actor_id = caelo_mcp_token_principal())))
  WITH CHECK (((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])) AND (caelo_mcp_tokens_manage_all() OR (actor_id = caelo_mcp_token_principal()))));

ALTER POLICY mcp_transport_sessions_own ON mcp_transport_sessions
  USING (((caelo_setting_is('caelo.actor_kind', 'system')) OR ((caelo_setting_is('caelo.actor_kind', 'human')) AND (EXISTS ( SELECT 1 FROM mcp_remote_connections c WHERE ((c.id = mcp_transport_sessions.connection_id) AND (c.actor_id = caelo_mcp_token_principal())))))))
  WITH CHECK (((caelo_setting_is('caelo.actor_kind', 'system')) OR ((caelo_setting_is('caelo.actor_kind', 'human')) AND (EXISTS ( SELECT 1 FROM mcp_remote_connections c WHERE ((c.id = mcp_transport_sessions.connection_id) AND (c.actor_id = caelo_mcp_token_principal())))))));

ALTER POLICY operator_access_sync_runs_insert ON operator_access_sync_runs
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY operator_access_sync_runs_prune ON operator_access_sync_runs
  USING (((caelo_setting_is('caelo.actor_kind', 'system')) AND (finished_at < (now() - '30 days'::interval))));

ALTER POLICY owner_bootstrap_tokens_system ON owner_bootstrap_tokens
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY password_reset_tokens_self_or_system ON password_reset_tokens
  USING (((user_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))))
  WITH CHECK (((user_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))));

ALTER POLICY plugin_grants_own_read ON plugin_capability_grants
  USING (((caelo_setting_is('caelo.actor_kind', 'plugin')) AND ((plugin_id)::text = current_setting('caelo.plugin_id', true))));

ALTER POLICY plugin_grants_owner_insert ON plugin_capability_grants
  WITH CHECK ((can_approve_plugin_installation() AND (revoked_at IS NULL) AND (revoked_by IS NULL) AND ((caelo_setting_is('caelo.actor_kind', 'system')) OR (approved_by = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid))));

ALTER POLICY plugin_grants_owner_revoke ON plugin_capability_grants
  USING (can_approve_plugin_installation())
  WITH CHECK ((can_approve_plugin_installation() AND ((caelo_setting_is('caelo.actor_kind', 'system')) OR (revoked_by = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid))));

ALTER POLICY plugin_grants_read ON plugin_capability_grants
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['system', 'human', 'ai'])));

ALTER POLICY plugin_data_build_state_read ON plugin_data_build_state
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY plugin_data_build_state_write ON plugin_data_build_state
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY plugin_data_stale_pages_read ON plugin_data_stale_pages
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY plugin_data_stale_pages_write ON plugin_data_stale_pages
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])))
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])));

ALTER POLICY plugin_errors_read ON plugin_errors
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY plugin_errors_write ON plugin_errors
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY plugin_event_cursors_scope ON plugin_event_cursors
  USING (((caelo_setting_is('caelo.actor_kind', 'system')) OR (current_setting('caelo.plugin_id', true) = (plugin_id)::text)))
  WITH CHECK (((caelo_setting_is('caelo.actor_kind', 'system')) OR (current_setting('caelo.plugin_id', true) = (plugin_id)::text)));

ALTER POLICY plugin_versions_own_read ON plugin_installation_versions
  USING (((caelo_setting_is('caelo.actor_kind', 'plugin')) AND ((plugin_id)::text = current_setting('caelo.plugin_id', true))));

ALTER POLICY plugin_versions_read ON plugin_installation_versions
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['system', 'human', 'ai'])));

ALTER POLICY plugin_versions_stage ON plugin_installation_versions
  WITH CHECK (((caelo_setting_in('caelo.actor_kind', ARRAY['system', 'human', 'ai'])) AND (status = 'pending') AND (approved_by IS NULL) AND (approved_at IS NULL) AND (expected_state_digest IS NULL) AND (submitted_by = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid)));

ALTER POLICY plugin_pending_actions_rw ON plugin_pending_actions
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])))
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY private_file_chunks_scope ON plugin_private_file_chunks
  USING (((caelo_setting_is('caelo.actor_kind', 'plugin')) AND (plugin_id = (NULLIF(current_setting('caelo.plugin_id', true), ''))::uuid)))
  WITH CHECK (((caelo_setting_is('caelo.actor_kind', 'plugin')) AND (plugin_id = (NULLIF(current_setting('caelo.plugin_id', true), ''))::uuid)));

ALTER POLICY private_files_scope ON plugin_private_files
  USING (((caelo_setting_is('caelo.actor_kind', 'plugin')) AND (plugin_id = (NULLIF(current_setting('caelo.plugin_id', true), ''))::uuid)))
  WITH CHECK (((caelo_setting_is('caelo.actor_kind', 'plugin')) AND (plugin_id = (NULLIF(current_setting('caelo.plugin_id', true), ''))::uuid)));

ALTER POLICY plugin_runtime_read ON plugin_runtime
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY plugin_runtime_write ON plugin_runtime
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY plugin_schema_provisions_system ON plugin_schema_provisions
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY plugin_tool_binding_consume ON plugin_tool_approval_bindings
  USING ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY plugin_tool_binding_insert ON plugin_tool_approval_bindings
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY plugin_tool_binding_read ON plugin_tool_approval_bindings
  USING ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY provisioning_outputs_authed ON provisioning_outputs
  USING ((NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY public_projection_outbox_publisher ON public_projection_outbox
  USING ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY rate_limit_buckets_system ON rate_limit_buckets
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY redirect_syncs_delete ON redirect_syncs
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY redirect_syncs_insert ON redirect_syncs
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY redirect_syncs_read ON redirect_syncs
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY sessions_self_or_system ON sessions
  USING (((user_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))))
  WITH CHECK (((user_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))));

ALTER POLICY telemetry_settings_authed ON telemetry_settings
  USING ((NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL))
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system'])));

ALTER POLICY url_migration_pending_rw ON url_migration_pending_actions
  USING ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])))
  WITH CHECK ((caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system'])));

ALTER POLICY users_self_or_system ON users
  USING (((id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))))
  WITH CHECK (((id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))));

-- actors and audit_events: their policies are created by
-- 9999_rls_policies.sql, which sorts after this file. A fresh install runs
-- 9999 after 0475 (and 9999 spells them with caelo_setting_is), so only an
-- install that already ran 9999 has these two policies to rewrite here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'actors_actor_scope' AND polrelid = 'actors'::regclass) THEN
    ALTER POLICY actors_actor_scope ON actors
      USING (((id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))))
      WITH CHECK (((id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'audit_events_actor_scope' AND polrelid = 'audit_events'::regclass) THEN
    ALTER POLICY audit_events_actor_scope ON audit_events
      USING (((actor_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))))
      WITH CHECK (((actor_id = (NULLIF(current_setting('caelo.actor_id', true), ''))::uuid) OR (caelo_setting_is('caelo.actor_kind', 'system'))));
  END IF;
END
$$;

COMMIT;
