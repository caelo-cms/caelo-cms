-- SPDX-License-Identifier: MPL-2.0
--
-- 0691 — issue #1594: the newest read each public database was written
-- from. Runs in both public databases (migrate.ts `public` and
-- `public-staging`), so both have one schema.
--
-- A publisher reads cms_admin under the projection lock and takes the read
-- transaction's id as its generation (and the database clock as its read
-- time); the lock ends with the read, and the public writes follow without
-- an admin transaction open. So an older read never overwrites a newer
-- publish:
--
--   published_projection_generations — per whole write unit (settings,
--     staging, staging_site, rate_limits, redirects, plugins): a publisher
--     raises the row to its generation before writing the unit and leaves
--     the unit alone when a newer one is there. For `comments` the row
--     only records the newest read that wrote comments (the comments
--     themselves are versioned one by one, below). Never deleted, so a
--     section a newer publish removed (a cleared cookie secret) cannot come
--     back from an older read; the raise's row lock serialises two
--     publishers of a unit.
--   published_comment_generations — per comment: moderation publishes
--     comments one by one, so a later publish need not carry the comments
--     an earlier one did; each comment is written only from a read newer
--     than the one that last wrote it.
--
-- Only the admin's publisher (admin_role as the system actor) reads or
-- writes them; the gateways never need them, so the visitor logins get
-- nothing.

CREATE TABLE IF NOT EXISTS published_projection_generations (
  unit       text PRIMARY KEY CHECK (unit IN (
               'settings', 'staging', 'staging_site', 'rate_limits', 'redirects', 'plugins', 'comments')),
  generation bigint      NOT NULL CHECK (generation > 0),
  read_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS published_comment_generations (
  id         uuid   PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation > 0)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['published_projection_generations', 'published_comment_generations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_publisher', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO admin_role USING (caelo_setting_is(%L, %L)) WITH CHECK (caelo_setting_is(%L, %L))',
      t || '_publisher', t, 'caelo.actor_kind', 'system', 'caelo.actor_kind', 'system');
  END LOOP;
END
$$;
