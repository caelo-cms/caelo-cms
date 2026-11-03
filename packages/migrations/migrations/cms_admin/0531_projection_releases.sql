-- SPDX-License-Identifier: MPL-2.0
--
-- 0531 — the two-target projection, frozen per Stage (issue #1329, gateway
-- hardening P3b-1, epic #763 E10; fixes N6: live visitors saw staged
-- plugin data before Publish live).
--
-- The release sections of the gateway projection — the plugin registry
-- with its grants, and every plugin's visitorProjection rows — follow the
-- release. A Stage freezes them with its build, under its deploy run id;
-- Publish live promotes exactly that frozen state to the live database; a
-- rollback restores the state of the build it puts back. Only narrowing
-- reaches either database at once (a plugin deactivated, a grant revoked:
-- packages/migrations/src/public-projection.ts `narrowRelease`); the other
-- sections (gateway settings, the staging gate, rate limits, moderated and
-- team comments, redirects) are published to both databases immediately,
-- as before.
--
--   projection_releases          one frozen release state per run that froze
--                                one (a Stage, an Owner's production build,
--                                and the bootstrap state of an install from
--                                before this migration), as written by
--                                `freezeRelease`. Read only by the publisher.
--   projection_release_pointers  which frozen state each environment's
--                                database serves. `staging` moves with a
--                                Stage; `live` only with Publish live, an
--                                Owner's production build and a rollback
--                                (scripts/no-automatic-production-deploy.
--                                test.ts pins every writer).
--   deploy_runs.projection_run_id  a production run's released state, which a
--                                rollback to that run restores.
--
-- A pointer move marks the `plugins` section stale (0281 outbox), so the
-- drain right after the commit publishes the newly pointed state.
--
-- Also (#1329): the staging site's own gateway cookie secret, so the
-- `settings` section never copies the live secret into the staging
-- database (staging is same-site with live); `redirects` as a projection
-- section (staging gets them through the projection, #1157); and team
-- posts in the comment archive (`posted_by`, comment_archive.post_team).

CREATE TABLE IF NOT EXISTS projection_releases (
  run_id    uuid PRIMARY KEY,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  -- Why the run froze it: a Stage, a production build, or the bootstrap of
  -- an install that had no frozen state yet.
  reason    text NOT NULL CHECK (reason IN ('stage', 'production-build', 'bootstrap')),
  state     jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_release_pointers (
  environment text PRIMARY KEY CHECK (environment IN ('live', 'staging')),
  run_id      uuid NOT NULL REFERENCES projection_releases (run_id),
  pointed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projection_release_pointers_run_idx
  ON projection_release_pointers (run_id);

ALTER TABLE deploy_runs ADD COLUMN IF NOT EXISTS projection_run_id uuid NULL;

-- Only the system publisher and the deploy ops (system or human, through
-- named ops) touch them; nothing reaches them from a chat.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projection_releases', 'projection_release_pointers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_actor_scope', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL) WITH CHECK (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL)',
      t || '_actor_scope', t);
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS caelo_projection_plugins ON projection_release_pointers;
CREATE TRIGGER caelo_projection_plugins
  AFTER INSERT OR UPDATE OR DELETE ON projection_release_pointers FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('plugins');

-- The staging site's own cookie secret (64 random hex characters).
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS gateway_staging_cookie_secret text NULL;
UPDATE site_settings
   SET gateway_staging_cookie_secret =
         replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
 WHERE gateway_staging_cookie_secret IS NULL;

DROP TRIGGER IF EXISTS caelo_projection_settings ON site_settings;
CREATE TRIGGER caelo_projection_settings
  AFTER INSERT OR UPDATE OF gateway_cookie_secret, gateway_staging_cookie_secret,
                            gateway_max_body_bytes, captcha_provider, captcha_pow_target_prefix
  ON site_settings FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');

-- Redirects reach the staging database through the projection.
ALTER TABLE public_projection_outbox DROP CONSTRAINT IF EXISTS public_projection_outbox_section_check;
ALTER TABLE public_projection_outbox ADD CONSTRAINT public_projection_outbox_section_check
  CHECK (section ~ '^(settings|staging|rate_limits|plugins|comments|redirects|plugin:[0-9a-f-]{36})$');

DROP TRIGGER IF EXISTS caelo_projection_redirects ON redirects;
CREATE TRIGGER caelo_projection_redirects
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON redirects FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('redirects');

-- Team posts: written straight as approved by the admin user who posts
-- them (comment_archive.post_team), never through the public inbox.
ALTER TABLE comment_archive ADD COLUMN IF NOT EXISTS posted_by uuid NULL REFERENCES actors (id);
