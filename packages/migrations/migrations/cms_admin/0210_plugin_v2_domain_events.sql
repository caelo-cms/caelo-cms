-- SPDX-License-Identifier: MPL-2.0
--
-- #392 (epic #380) — transactional domain-event outbox.
--
-- Deep plugins need to react to core writes: the international-site
-- plugin must flag translated variants stale when their source page
-- changes. Pre-cleanup this was hardcoded (recomputePageContentHash
-- calls sprinkled into four core write paths, deleted in Phase A).
-- The generic replacement is an append-only outbox written IN THE SAME
-- TRANSACTION as the triggering write at the Query API boundary — a
-- rolled-back write emits no event, an applied write always does.
--
-- Consumers are plugin workers POLLING from their existing schedule via
-- ctx.events.poll (capability `domain_events`, release-signed only) —
-- deliberately NOT an in-process event bus; no new runtime concepts.
-- Events are ephemeral signals (snapshots remain the durable history):
-- the GC worker prunes rows past the retention window.
--
-- plugin_event_cursors persists each plugin's read position so a worker
-- resumes where it left off across restarts. Scoped by caelo.plugin_id
-- like every plugin-owned row.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS domain_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN (
    'page.created', 'page.updated', 'page.deleted', 'page.published',
    'module.updated'
  )),
  entity_id   uuid NOT NULL,
  -- Context the consumer needs without a join: slug at event time,
  -- chat_branch_id when the write was branch-scoped (NULL = live), etc.
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS domain_events_kind_id_idx ON domain_events (kind, id);
CREATE INDEX IF NOT EXISTS domain_events_created_at_idx ON domain_events (created_at);

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;

-- Writers: every core write op (human/ai/system/plugin actor) inserts in
-- its own tx. Readers: the plugin poll handle (actor_kind='plugin') and
-- system (GC, diagnostics). Never visitor-facing.
DROP POLICY IF EXISTS domain_events_rw ON domain_events;
CREATE POLICY domain_events_rw ON domain_events
  USING (current_setting('caelo.actor_kind', true) IN ('system', 'plugin'))
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system', 'plugin'));

GRANT SELECT, INSERT, DELETE ON domain_events TO admin_role;

CREATE TABLE IF NOT EXISTS plugin_event_cursors (
  plugin_id   uuid PRIMARY KEY REFERENCES plugins(id) ON DELETE CASCADE,
  cursor_id   bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plugin_event_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_event_cursors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plugin_event_cursors_scope ON plugin_event_cursors;
CREATE POLICY plugin_event_cursors_scope ON plugin_event_cursors
  USING (
    current_setting('caelo.actor_kind', true) = 'system'
    OR current_setting('caelo.plugin_id', true) = plugin_id::text
  )
  WITH CHECK (
    current_setting('caelo.actor_kind', true) = 'system'
    OR current_setting('caelo.plugin_id', true) = plugin_id::text
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON plugin_event_cursors TO admin_role;

COMMIT;
