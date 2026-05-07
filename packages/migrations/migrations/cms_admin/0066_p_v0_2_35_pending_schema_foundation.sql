-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.35 — pending-actions schema foundation. Adds three things to
-- every *_pending_actions table shipped in v0.2.19 → v0.2.30:
--
--   1. chat_session_id uuid — the chat that originated the proposal.
--      Lets the Owner UI render "from chat: <title>" per row, and
--      lets the AI filter the ## Pending proposals block to its own
--      session's queue (v0.2.38).
--
--   2. payload_hash text — SHA-256 of normalized payload jsonb.
--      Computed at propose time. Partial unique index on
--      (payload_hash) WHERE status='pending' makes duplicate proposals
--      a DB-level reject, closing the race the system-prompt block
--      can't enforce (v0.2.38 self-filter is a soft signal; this is
--      the hard one).
--
--   3. status='cancelled' added to the CHECK constraint. Lets AI
--      withdraw a proposal it queued in error via cancel_proposal
--      (v0.2.37) without making the Owner click Reject.
--
-- All 13 tables touched in one migration so the schema stays uniform.
-- locale_pending_actions, plugin_rate_limit_proposals,
-- site_memory_proposals, skill_proposals (older shapes) get only
-- chat_session_id — they have their own status enums and dedup
-- semantics that don't fit cleanly.

-- ─── Per-table column adds + status CHECK update ─────────────────────

-- helper: drop+recreate the status CHECK to include 'cancelled'.
-- Postgres requires ALTER ... DROP CONSTRAINT + ADD CONSTRAINT for
-- enum-style CHECKs since IF NOT EXISTS is not supported on CHECKs.

DO $$
DECLARE
  t text;
  pending_tables text[] := ARRAY[
    'deploy_pending_actions',
    'layout_pending_actions',
    'user_pending_actions',
    'role_pending_actions',
    'snapshot_revert_pending_actions',
    'experiment_pending_actions',
    'email_config_pending_actions',
    'ai_providers_pending_actions',
    'mcp_token_pending_actions',
    'template_pending_actions',
    'domain_pending_actions'
  ];
BEGIN
  FOREACH t IN ARRAY pending_tables LOOP
    -- chat_session_id: nullable (v0.2.19 → v0.2.30 rows already exist
    -- without it; backfill on best-effort would require log-archaeology
    -- and isn't worth it).
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL',
      t
    );

    -- payload_hash: nullable to allow existing rows. New rows will
    -- always populate it. Index is partial on status='pending', so
    -- existing applied/rejected rows don't conflict.
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS payload_hash text NULL',
      t
    );

    -- Partial unique index for dedup. Duplicate (payload_hash) among
    -- pending rows is rejected at the DB. Once a row decides
    -- (applied/rejected/cancelled/superseded), the same hash can be
    -- proposed again.
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (payload_hash) WHERE status = ''pending'' AND payload_hash IS NOT NULL',
      t || '_payload_hash_pending_uniq',
      t
    );

    -- Update status CHECK to include 'cancelled'. We have to find the
    -- existing CHECK constraint name (Postgres auto-generates) and
    -- drop it, then re-add with the expanded enum.
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t,
      t || '_status_check'
    );
    EXECUTE format(
      $cmd$
        ALTER TABLE %I
        ADD CONSTRAINT %I
        CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled'))
      $cmd$,
      t,
      t || '_status_check'
    );
  END LOOP;
END $$;

-- Older proposal tables that share the per-domain pattern but with
-- different shapes: locale_pending_actions + plugin_rate_limit_proposals
-- need chat_session_id added; site_memory_proposals + skill_proposals
-- already have it from P5/P10A.
ALTER TABLE locale_pending_actions
  ADD COLUMN IF NOT EXISTS chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL;

ALTER TABLE plugin_rate_limit_proposals
  ADD COLUMN IF NOT EXISTS chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL;
