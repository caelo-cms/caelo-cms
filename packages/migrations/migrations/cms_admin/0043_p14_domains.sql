-- SPDX-License-Identifier: MPL-2.0
--
-- P14 — domains registry. Each row represents a hostname Caelo serves.
-- Caddyfile generation reads from this table; cms-provision hot-reloads
-- Caddy after `domains.add`. TLS state is tracked here for the Owner UI.

CREATE TABLE IF NOT EXISTS domains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname        text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('admin', 'public', 'locale-public')),
  -- For 'locale-public' rows, the locale code this hostname serves.
  -- NULL on 'admin' / 'public' rows.
  locale_code     text NULL REFERENCES locales(code),
  tls_status      text NOT NULL DEFAULT 'pending'
    CHECK (tls_status IN ('pending', 'active', 'failed', 'unknown')),
  tls_expires_at  timestamptz NULL,
  tls_error       text NULL,
  last_verified_at timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NULL REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS domains_kind_idx ON domains (kind);

ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS domains_authenticated_scope ON domains;
CREATE POLICY domains_authenticated_scope ON domains
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Extend deploy_targets with provisioner state so cms-provision can
-- record which Pulumi stack/host the target was provisioned by.
ALTER TABLE deploy_targets
  ADD COLUMN IF NOT EXISTS provisioner       text NOT NULL DEFAULT 'manual'
    CHECK (provisioner IN ('manual', 'self-hosted', 'gcp', 'aws', 'azure')),
  ADD COLUMN IF NOT EXISTS provisioner_state jsonb NOT NULL DEFAULT '{}'::jsonb;
