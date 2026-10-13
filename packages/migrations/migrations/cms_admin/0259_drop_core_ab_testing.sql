-- SPDX-License-Identifier: MPL-2.0
--
-- 0259 — cut A/B testing out of core (epic #676, PR-B).
--
-- A/B testing moves into a release-signed `ab-testing` plugin that runs only
-- with visitor consent (#674). Core keeps no experiment table, op, route or
-- build step — "delete, don't migrate", as with core i18n (#380): the plugin
-- brings its own storage; nothing here is carried over.
--
-- Dropped:
--   experiment_pending_actions   the activate/complete approval queue (0060)
--   experiment_assignments       per-visitor impression counts (0040)
--   experiments                  the experiments themselves (0040)
--   ab_assignment_aggregates     never written by any code path (0046)
--   module_snapshots.experiment_id / variant_label
--                                never populated (0007)
--
-- Their RLS policies — the gateway_role RESTRICTIVE ones from 0252 included
-- — and column grants go with the tables. caelo_grant_gateway_role() is
-- replaced whole without the experiment grants, so bootstrap.sh and the
-- self-hosted provisioner, which call it after (re)creating gateway_role,
-- converge on the remaining set instead of failing on the dropped tables.
--
-- Power-MCP approval hand-offs that point at an experiment proposal can no
-- longer be resolved (the proposal table is gone); they are removed too.

DELETE FROM mcp_approval_handoffs WHERE domain = 'experiments';

DROP TABLE IF EXISTS experiment_pending_actions;
DROP TABLE IF EXISTS experiment_assignments;
DROP TABLE IF EXISTS experiments;
DROP TABLE IF EXISTS ab_assignment_aggregates;

ALTER TABLE module_snapshots
  DROP COLUMN IF EXISTS experiment_id,
  DROP COLUMN IF EXISTS variant_label;

CREATE OR REPLACE FUNCTION caelo_grant_gateway_role() RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN
    RETURN;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gateway_role', current_database());
  GRANT USAGE ON SCHEMA public TO gateway_role;

  -- Settings the gateway runs with. The cookie secret is seeded below and
  -- rotated by the admin (gateway.rotate_cookie_secret); the gateway never
  -- writes site_settings.
  GRANT SELECT (id, gateway_cookie_secret, gateway_max_body_bytes, captcha_provider,
                captcha_pow_target_prefix)
    ON site_settings TO gateway_role;

  -- Rate limiting.
  GRANT SELECT ON plugin_rate_limit_overrides, rate_limit_profiles TO gateway_role;
  GRANT SELECT, INSERT, UPDATE ON rate_limit_buckets TO gateway_role;
  DROP POLICY IF EXISTS rate_limit_buckets_gateway_keys ON rate_limit_buckets;
  CREATE POLICY rate_limit_buckets_gateway_keys ON rate_limit_buckets
    AS RESTRICTIVE FOR ALL TO gateway_role
    USING (starts_with(key, 'gateway:') OR starts_with(key, 'gateway-ip:'))
    WITH CHECK (starts_with(key, 'gateway:') OR starts_with(key, 'gateway-ip:'));

  -- Proof-of-work captcha: issue, then claim once.
  GRANT SELECT (challenge, target_hex, expires_at, used_at) ON pow_challenges TO gateway_role;
  GRANT INSERT (challenge, target_hex, expires_at, visitor_id_hash)
    ON pow_challenges TO gateway_role;
  GRANT UPDATE (used_at) ON pow_challenges TO gateway_role;

  -- Request log: append only.
  GRANT INSERT (plugin_slug, operation, visitor_id_hash, status_code, duration_ms, body_bytes,
                was_rate_limited, was_honeypot_caught, captcha_passed, error_kind)
    ON gateway_request_log TO gateway_role;

  -- Plugin op audit: append only, plugin actors only.
  GRANT INSERT (actor_id, operation, input_hash, succeeded, entity_id)
    ON audit_events TO gateway_role;
  DROP POLICY IF EXISTS audit_events_gateway_plugin_only ON audit_events;
  CREATE POLICY audit_events_gateway_plugin_only ON audit_events
    AS RESTRICTIVE FOR ALL TO gateway_role
    USING (false)
    WITH CHECK (EXISTS (
      SELECT 1 FROM actors a WHERE a.id = audit_events.actor_id AND a.plugin_id IS NOT NULL
    ));

  -- The plugin registry, read-only.
  GRANT SELECT (id, slug, version, tier, status, manifest_json, source_code)
    ON plugins TO gateway_role;
  GRANT SELECT (id, plugin_id) ON actors TO gateway_role;
  GRANT SELECT (id, plugin_id, artifact_digest, capability, revoked_at)
    ON plugin_capability_grants TO gateway_role;
  GRANT SELECT (plugin_id, artifact_digest, status)
    ON plugin_installation_versions TO gateway_role;

  -- Issue #634 (migration 0252) — the visitor paths the gateway serves.

  -- Approved comments (comments plugin `list_approved` ->
  -- comment_archive.list_for_page): what the static page already shows.
  -- Rejected and spam rows stay out of reach whatever status is asked for.
  GRANT SELECT (id, public_row_id, page_id, parent_id, author_name, content, status, submitted_at,
                archived_at)
    ON comment_archive TO gateway_role;
  DROP POLICY IF EXISTS comment_archive_gateway_approved_only ON comment_archive;
  CREATE POLICY comment_archive_gateway_approved_only ON comment_archive
    AS RESTRICTIVE FOR ALL TO gateway_role
    USING (status = 'approved')
    WITH CHECK (false);
END
$fn$;

REVOKE ALL ON FUNCTION caelo_grant_gateway_role() FROM PUBLIC;

SELECT caelo_grant_gateway_role();
