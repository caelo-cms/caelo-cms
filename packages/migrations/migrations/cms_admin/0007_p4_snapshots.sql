-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 4: snapshot versioning + revert.
--
-- One site_snapshots row groups N entity-level snapshot rows
-- (modules / templates / pages / page_layouts) into a single revertible
-- unit. Snapshots are emitted in the same transaction as the live write so
-- the live tables and the snapshot history can never disagree.
--
-- chat_task_id and chat_branch_id are P5 hooks (chat sessions); P4 leaves
-- them NULL. experiment_id + variant_label on module_snapshots are P12A
-- A/B-variant hooks; P4 leaves them NULL too. Reserving the columns now
-- means neither feature requires a migration churn later.
--
-- revert_of points at the *target* of a revert (the snapshot whose state
-- was restored). The revert itself is appended as a new snapshot — history
-- is never destructively rewound, matching CMS_REQUIREMENTS §5 + §7
-- "all writes pass through the audit log".

------------------------------------------------------------------------
-- site_snapshots — the timeline header rows
------------------------------------------------------------------------
CREATE TABLE site_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        uuid NOT NULL REFERENCES actors(id),
  description     text NOT NULL,
  chat_task_id    uuid NULL,
  chat_branch_id  uuid NULL,
  revert_of       uuid NULL REFERENCES site_snapshots(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX site_snapshots_chat_task_id_idx ON site_snapshots (chat_task_id) WHERE chat_task_id IS NOT NULL;
CREATE INDEX site_snapshots_created_at_idx ON site_snapshots (created_at DESC);

--> statement-breakpoint

------------------------------------------------------------------------
-- module_snapshots
------------------------------------------------------------------------
CREATE TABLE module_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  module_id         uuid NOT NULL REFERENCES modules(id),
  state             jsonb NOT NULL,
  experiment_id     uuid NULL,
  variant_label     text NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX module_snapshots_module_idx ON module_snapshots (module_id, site_snapshot_id);
CREATE INDEX module_snapshots_site_idx ON module_snapshots (site_snapshot_id);

--> statement-breakpoint

------------------------------------------------------------------------
-- template_snapshots
------------------------------------------------------------------------
CREATE TABLE template_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  template_id       uuid NOT NULL REFERENCES templates(id),
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX template_snapshots_template_idx ON template_snapshots (template_id, site_snapshot_id);
CREATE INDEX template_snapshots_site_idx ON template_snapshots (site_snapshot_id);

--> statement-breakpoint

------------------------------------------------------------------------
-- page_snapshots — page metadata only (not the layout)
------------------------------------------------------------------------
CREATE TABLE page_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  page_id           uuid NOT NULL REFERENCES pages(id),
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX page_snapshots_page_idx ON page_snapshots (page_id, site_snapshot_id);
CREATE INDEX page_snapshots_site_idx ON page_snapshots (site_snapshot_id);

--> statement-breakpoint

------------------------------------------------------------------------
-- page_layout_snapshots — separate so reordering a page's modules does
-- not bloat page_snapshots with redundant metadata copies
------------------------------------------------------------------------
CREATE TABLE page_layout_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  page_id           uuid NOT NULL REFERENCES pages(id),
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX page_layout_snapshots_page_idx ON page_layout_snapshots (page_id, site_snapshot_id);
CREATE INDEX page_layout_snapshots_site_idx ON page_layout_snapshots (site_snapshot_id);

--> statement-breakpoint

------------------------------------------------------------------------
-- RLS: site-wide content. Same shape as the P3 content tables — any
-- authenticated Query API caller (human / ai / system) reads + writes;
-- anonymous DB connections see nothing. Inlined here, not appended to
-- 9999_rls_policies.sql, because the migration runner is once-per-
-- filename and 9999 has already been applied.
------------------------------------------------------------------------

ALTER TABLE site_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_snapshots_authenticated_scope ON site_snapshots;
CREATE POLICY site_snapshots_authenticated_scope ON site_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE module_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS module_snapshots_authenticated_scope ON module_snapshots;
CREATE POLICY module_snapshots_authenticated_scope ON module_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE template_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS template_snapshots_authenticated_scope ON template_snapshots;
CREATE POLICY template_snapshots_authenticated_scope ON template_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE page_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_snapshots_authenticated_scope ON page_snapshots;
CREATE POLICY page_snapshots_authenticated_scope ON page_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE page_layout_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_layout_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_layout_snapshots_authenticated_scope ON page_layout_snapshots;
CREATE POLICY page_layout_snapshots_authenticated_scope ON page_layout_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
