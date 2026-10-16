-- SPDX-License-Identifier: MPL-2.0
--
-- 0281 — the outbox that keeps the published projection current (issue
-- #635, CLAUDE.md §2: the public side has no path to cms_admin).
--
-- The API gateway no longer reads cms_admin. What it needs from authoring
-- state, the admin PUBLISHES into cms_public (cms_public migration 0280).
-- A publish cannot share a transaction with the cms_admin write that
-- caused it (two databases), so every write that changes published state
-- records, in ITS OWN transaction, which section is now stale:
--
--   public_projection_outbox   one row per (statement, section) — or per
--                              comment for `comments` — written by the
--                              triggers below, drained by the admin's
--                              publisher (admin-core public-projection),
--                              which republishes the section from the
--                              source of truth and deletes the rows
--
-- A write that commits always leaves its outbox row, whoever made it (an
-- op, a branch publish, a revert, a migration, the previous release's
-- admin during an upgrade), and a rolled-back one leaves none. A write made
-- through the admin's DatabaseAdapter is published right after it commits,
-- before the request returns (the trigger flags the transaction with
-- `caelo.projection_dirty`). The admin also polls the outbox, so a write
-- from anywhere else, or a publish that failed, still converges; delivery
-- does not depend on any listener being up.
--
-- Sections and their sources:
--   settings     site_settings (the four gateway columns)
--   staging      staging_access
--   rate_limits  plugin_rate_limit_overrides, rate_limit_profiles
--   plugins      plugins, actors, plugin_capability_grants,
--                plugin_installation_versions
--   comments     comment_archive (row level: entity_id = the archive id)
--   plugin:<id>  a plugin's private tables named in its `visitorProjection`
--                (triggers added by plugin-sandbox adminSchemaFromSpec)
--
-- Also: site_settings.auto_redeploy_last_public_event_id, the redeploy
-- orchestrator's watermark in cms_public.gateway_plugin_op_events.
--
-- Expand-only (#696): new table, function, triggers and column. The
-- previous release's gateway keeps reading cms_admin as gateway_role until
-- it is rolled; its grants are dropped in a later contract migration.

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS public_projection_outbox (
  id         bigserial PRIMARY KEY,
  section    text NOT NULL
             CHECK (section ~ '^(settings|staging|rate_limits|plugins|comments|plugin:[0-9a-f-]{36})$'),
  entity_id  uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public_projection_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_projection_outbox FORCE ROW LEVEL SECURITY;
-- Any write path may mark a section stale (the trigger runs as the writer,
-- whatever actor it acts for); only the system publisher reads and drains.
DROP POLICY IF EXISTS public_projection_outbox_mark ON public_projection_outbox;
CREATE POLICY public_projection_outbox_mark ON public_projection_outbox
  FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS public_projection_outbox_publisher ON public_projection_outbox;
CREATE POLICY public_projection_outbox_publisher ON public_projection_outbox
  USING (current_setting('caelo.actor_kind', true) = 'system');

/**
 * Trigger: mark TG_ARGV[0] stale. Row-level triggers (comments) record the
 * row's id; statement-level ones record the section once per statement.
 */
CREATE OR REPLACE FUNCTION caelo_mark_public_projection() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  entity uuid := NULL;
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    entity := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  END IF;
  INSERT INTO public_projection_outbox (section, entity_id) VALUES (TG_ARGV[0], entity);
  -- Tells the writing process (query-api DatabaseAdapter) to publish right
  -- after its commit, before its request returns. Transaction-local: a
  -- rollback clears it together with the outbox row.
  PERFORM set_config('caelo.projection_dirty', 'on', true);
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS caelo_projection_settings ON site_settings;
CREATE TRIGGER caelo_projection_settings
  AFTER INSERT OR UPDATE OF gateway_cookie_secret, gateway_max_body_bytes, captcha_provider,
                            captcha_pow_target_prefix
  ON site_settings FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');

DROP TRIGGER IF EXISTS caelo_projection_staging ON staging_access;
CREATE TRIGGER caelo_projection_staging
  AFTER INSERT OR UPDATE OR DELETE ON staging_access FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('staging');

DROP TRIGGER IF EXISTS caelo_projection_rate_limits ON plugin_rate_limit_overrides;
CREATE TRIGGER caelo_projection_rate_limits
  AFTER INSERT OR UPDATE OR DELETE ON plugin_rate_limit_overrides FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('rate_limits');
DROP TRIGGER IF EXISTS caelo_projection_rate_limits ON rate_limit_profiles;
CREATE TRIGGER caelo_projection_rate_limits
  AFTER INSERT OR UPDATE OR DELETE ON rate_limit_profiles FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('rate_limits');

DROP TRIGGER IF EXISTS caelo_projection_plugins ON plugins;
CREATE TRIGGER caelo_projection_plugins
  AFTER INSERT OR UPDATE OR DELETE ON plugins FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('plugins');
DROP TRIGGER IF EXISTS caelo_projection_plugins ON actors;
CREATE TRIGGER caelo_projection_plugins
  AFTER INSERT OR UPDATE OF plugin_id OR DELETE ON actors FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('plugins');
DROP TRIGGER IF EXISTS caelo_projection_plugins ON plugin_capability_grants;
CREATE TRIGGER caelo_projection_plugins
  AFTER INSERT OR UPDATE OR DELETE ON plugin_capability_grants FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('plugins');
DROP TRIGGER IF EXISTS caelo_projection_plugins ON plugin_installation_versions;
CREATE TRIGGER caelo_projection_plugins
  AFTER INSERT OR UPDATE OR DELETE ON plugin_installation_versions FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('plugins');

DROP TRIGGER IF EXISTS caelo_projection_comments ON comment_archive;
CREATE TRIGGER caelo_projection_comments
  AFTER INSERT OR UPDATE OR DELETE ON comment_archive FOR EACH ROW
  EXECUTE FUNCTION caelo_mark_public_projection('comments');

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS auto_redeploy_last_public_event_id bigint NOT NULL DEFAULT 0;
