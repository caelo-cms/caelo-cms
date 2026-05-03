-- SPDX-License-Identifier: MPL-2.0
--
-- P13 ideas-pass — Owner-defined rate-limit profiles. A single named
-- profile (e.g. `visitor-writes` = 5/60s) can be referenced by many
-- per-(plugin, op) overrides. Tightening the profile updates every op
-- that references it in one Owner action.

CREATE TABLE IF NOT EXISTS rate_limit_profiles (
  name             text PRIMARY KEY,
  description      text NOT NULL DEFAULT '',
  per_visitor_max  int  NOT NULL CHECK (per_visitor_max > 0),
  window_seconds   int  NOT NULL CHECK (window_seconds BETWEEN 1 AND 3600),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES actors(id),
  CONSTRAINT rate_limit_profiles_name_shape CHECK (name ~ '^[a-z][a-z0-9-]*$')
);

ALTER TABLE rate_limit_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_limit_profiles_authenticated_scope ON rate_limit_profiles;
CREATE POLICY rate_limit_profiles_authenticated_scope ON rate_limit_profiles
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Each override row may now reference a profile. NULL keeps the legacy
-- per-row max/window values; non-NULL means "use the profile's values".
ALTER TABLE plugin_rate_limit_overrides
  ADD COLUMN IF NOT EXISTS profile_name text NULL REFERENCES rate_limit_profiles(name) ON DELETE SET NULL;

-- Two seed profiles for v1; Owner can edit / add more.
INSERT INTO rate_limit_profiles (name, description, per_visitor_max, window_seconds)
VALUES
  ('visitor-writes', 'Tight cap for visitor write surfaces (forms, comments)', 5, 60),
  ('admin-reads',    'Looser cap for admin read surfaces',                   120, 60)
ON CONFLICT (name) DO NOTHING;
