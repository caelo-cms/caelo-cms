-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 2.2 audit / soft-delete / rate-limit schema changes.
--
-- 1. audit_events gains result-shape columns (entity_id + result_summary) so
--    "who did what" stays answerable beyond just "what input shape was sent".
-- 2. users gains a soft-delete flag (deleted_at) so deleting a user no longer
--    erases their audit trail via FK cascade.
-- 3. New rate_limit_buckets table replaces the per-process in-memory limiter
--    so multi-replica deployments share a single window per key.

------------------------------------------------------------------------
-- audit_events: result-shape columns
------------------------------------------------------------------------
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS entity_id uuid NULL,
  ADD COLUMN IF NOT EXISTS result_summary text NULL;

CREATE INDEX IF NOT EXISTS audit_events_entity_id_idx
  ON audit_events (entity_id) WHERE entity_id IS NOT NULL;

------------------------------------------------------------------------
-- users.deleted_at — soft delete preserves the audit trail
------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS users_deleted_at_idx
  ON users (deleted_at) WHERE deleted_at IS NOT NULL;

------------------------------------------------------------------------
-- rate_limit_buckets — Postgres-backed sliding window
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_expires_at_idx
  ON rate_limit_buckets (expires_at);

ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_buckets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_limit_buckets_system ON rate_limit_buckets;
CREATE POLICY rate_limit_buckets_system ON rate_limit_buckets
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');
