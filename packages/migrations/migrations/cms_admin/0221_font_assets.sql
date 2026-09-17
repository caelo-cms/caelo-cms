-- SPDX-License-Identifier: MPL-2.0
-- Core-owned immutable font faces. Files stay private until explicitly bound
-- to published content. Revisions are retained for theme history and plugins.
CREATE TABLE font_assets (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 48 AND 8388608),
  created_by uuid NOT NULL REFERENCES actors(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(metadata) = 'object' AND metadata ? 'id' AND metadata ? 'sha256' AND metadata->>'id' = id::text AND metadata->>'sha256' = sha256)
);
ALTER TABLE font_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE font_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY font_assets_read ON font_assets FOR SELECT USING (
  NULLIF(current_setting('caelo.actor_id', true), '') IS NOT NULL AND
  current_setting('caelo.actor_kind', true) IN ('human','ai','system')
);
CREATE POLICY font_assets_insert ON font_assets FOR INSERT WITH CHECK (
  created_by = NULLIF(current_setting('caelo.actor_id', true), '')::uuid AND
  current_setting('caelo.actor_kind', true) IN ('human','ai','system')
);
-- No UPDATE or DELETE policy: restoring snapshots must always resolve the
-- original bytes and license. New uploads create new immutable revisions.
