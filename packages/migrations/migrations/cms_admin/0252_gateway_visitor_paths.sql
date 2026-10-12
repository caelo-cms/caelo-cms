-- SPDX-License-Identifier: MPL-2.0
--
-- 0252 — the gateway's visitor paths (issue #634).
--
-- Migration 0248 gave the API gateway its narrow `gateway_role`, but three
-- visitor features read cms_admin state that role could not reach (and that
-- the gateway's operation registry did not hold):
--
--   /api/variant/assign          experiments.get_active +
--                                experiments.record_assignment
--   comments `list_approved`     comment_archive.list_for_page (ctx.cms.call)
--
-- This extends caelo_grant_gateway_role() with exactly what those
-- operations touch (plugin-host gateway-ops.ts):
--
--   read   experiments            id, slug, status, variants — ACTIVE rows
--                                 only (RESTRICTIVE policy)
--   upsert experiment_assignments impression counter, only for active
--                                 experiments
--   read   comment_archive        APPROVED rows only (RESTRICTIVE policy) —
--                                 what the published page already shows
--
-- The RESTRICTIVE policies bind only gateway_role; every other role keeps
-- the permissive policies from 0040 / 0054 unchanged. Nothing is granted on
-- pages, drafts, rejected or spam comments, or any authoring column.
--
-- The plugin captcha fix in the same change needs no grant: the gateway
-- already verifies and claims proofs in pow_challenges (0248) and now hands
-- its verdict to the plugin host.
--
-- The function is replaced whole (0248's grants + the ones below) so
-- bootstrap.sh and the self-hosted provisioner, which call it after
-- creating the role on a database that already ran these migrations,
-- converge on the same set.

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

  -- A/B variant assignment (/api/variant/assign): read the variant weights
  -- of an ACTIVE experiment by slug, then count the impression. Drafts and
  -- completed experiments, the page, the author and the winner stay out of
  -- reach.
  GRANT SELECT (id, slug, status, variants) ON experiments TO gateway_role;
  DROP POLICY IF EXISTS experiments_gateway_active_only ON experiments;
  CREATE POLICY experiments_gateway_active_only ON experiments
    AS RESTRICTIVE FOR ALL TO gateway_role
    USING (status = 'active')
    WITH CHECK (false);
  -- INSERT ... ON CONFLICT DO UPDATE needs SELECT on the conflict key and
  -- on the column the update reads (impressions).
  GRANT SELECT (experiment_id, variant_label, visitor_id_hash, impressions)
    ON experiment_assignments TO gateway_role;
  GRANT INSERT (experiment_id, variant_label, visitor_id_hash, impressions, first_seen_at,
                last_seen_at)
    ON experiment_assignments TO gateway_role;
  GRANT UPDATE (impressions, last_seen_at) ON experiment_assignments TO gateway_role;
  DROP POLICY IF EXISTS experiment_assignments_gateway_active_only ON experiment_assignments;
  CREATE POLICY experiment_assignments_gateway_active_only ON experiment_assignments
    AS RESTRICTIVE FOR ALL TO gateway_role
    USING (EXISTS (SELECT 1 FROM experiments e
                   WHERE e.id = experiment_assignments.experiment_id AND e.status = 'active'))
    WITH CHECK (EXISTS (SELECT 1 FROM experiments e
                        WHERE e.id = experiment_assignments.experiment_id AND e.status = 'active'));

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
