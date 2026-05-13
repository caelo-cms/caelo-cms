-- SPDX-License-Identifier: MPL-2.0

-- v0.5.3 — Whole-blob branched snapshots for structured_sets (theme,
-- nav-menu, taxonomy, link-list).
--
-- v0.5.1 added structured_set_operations for per-item stage granularity
-- on ordered lists, but the live `structured_sets` row was still
-- overwritten unconditionally by `structured_sets.set` — meaning two
-- chats editing the same set stepped on each other live.
--
-- v0.5.3 fixes this by emitting a whole-blob snapshot when
-- ctx.chatBranchId is set, and skipping the live UPSERT. The picker
-- UI continues to use structured_set_operations for granularity on
-- list kinds; theme stays whole-blob (one item, one snapshot).

CREATE TABLE structured_set_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id   uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  structured_set_id  uuid NOT NULL REFERENCES structured_sets(id) ON DELETE CASCADE,
  -- state shape: { schemaVersion, kind, slug, displayName, items, deletedAt }
  state              jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX structured_set_snapshots_set_idx
  ON structured_set_snapshots (structured_set_id, site_snapshot_id);
CREATE INDEX structured_set_snapshots_site_idx
  ON structured_set_snapshots (site_snapshot_id);

ALTER TABLE structured_set_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE structured_set_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS structured_set_snapshots_authenticated_scope ON structured_set_snapshots;
CREATE POLICY structured_set_snapshots_authenticated_scope ON structured_set_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

-- v0.5.3 — extend chat_entity_locks enum to cover page-bound + global
-- config locks. The v0.5.0 set only covered the truly global entities;
-- v0.5.3 closes the lock-coverage gap surfaced by the v0.5 audit
-- (pages, site_settings, site_defaults were unguarded — two chats
-- could clobber each other live).
ALTER TABLE chat_entity_locks
  DROP CONSTRAINT IF EXISTS chat_entity_locks_entity_kind_check;
ALTER TABLE chat_entity_locks
  ADD CONSTRAINT chat_entity_locks_entity_kind_check
  CHECK (entity_kind IN (
    'module',
    'template',
    'pageLayout',
    'layout',
    'structuredSet',
    'redirect',
    'page',
    'siteSettings',
    'siteDefaults'
  ));
