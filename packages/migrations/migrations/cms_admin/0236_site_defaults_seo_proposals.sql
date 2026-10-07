-- SPDX-License-Identifier: MPL-2.0
--
-- 0236 — site_defaults_pending_actions: the §11.A proposal table for the
-- site SEO settings (base URL, sitemap toggle, Organization JSON-LD).
--
-- Until now `site_defaults.set_seo` was reachable only from the Owner's
-- Security → SEO page, while the static generator refuses to build with
-- no base URL (#551). The AI could see the blocker and not clear it. The
-- base URL rewrites every canonical, og:url, hreflang target and sitemap
-- entry at the next deploy, so the AI proposes and the Owner approves
-- (`propose_set_site_seo` → `site_defaults.execute_proposal`).
--
-- Canonical pending shape (docs/propose-execute-pattern.md), including
-- the v0.2.35 chat origin + payload-hash dedup and the 'cancelled' state
-- `pending_proposals.cancel` writes.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS site_defaults_pending_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('set_seo')),
  proposed_by      uuid NOT NULL REFERENCES actors(id),
  payload          jsonb NOT NULL,
  preview          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz NULL,
  decided_by       uuid NULL REFERENCES actors(id),
  decision_reason  text NULL,
  chat_session_id  uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  payload_hash     text NULL
);

CREATE INDEX IF NOT EXISTS site_defaults_pending_actions_status_idx
  ON site_defaults_pending_actions (status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS site_defaults_pending_actions_payload_hash_pending_uniq
  ON site_defaults_pending_actions (payload_hash)
  WHERE status = 'pending' AND payload_hash IS NOT NULL;

ALTER TABLE site_defaults_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_defaults_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_defaults_pending_actions_authenticated_scope
  ON site_defaults_pending_actions;
CREATE POLICY site_defaults_pending_actions_authenticated_scope ON site_defaults_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
