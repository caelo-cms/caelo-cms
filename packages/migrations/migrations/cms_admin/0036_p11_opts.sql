-- SPDX-License-Identifier: MPL-2.0
--
-- P11 review pass — five optimizations that tighten Tier-2 lifecycle:
--   2. Per-plugin actor row at activate time (already-in-place actors.kind
--      column has no CHECK, so we don't need to widen anything; this
--      migration just adds a partial-unique index so the activate path
--      can ON CONFLICT DO NOTHING by plugin_id).
--   5. New 'rejected' status on plugins. plugins.reject now flips status
--      instead of DELETE so the audit trail + the Owner UI history
--      survive the rejection. Add nullable rejection_reason column.

------------------------------------------------------------------------
-- Opt 2 — partial unique index on actors.plugin_id so the activate
-- path's ON CONFLICT (plugin_id) DO NOTHING is well-defined.
------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS actors_plugin_id_unique
  ON actors (plugin_id) WHERE plugin_id IS NOT NULL;

------------------------------------------------------------------------
-- Opt 5 — extend plugins.status with 'rejected' + add rejection_reason.
------------------------------------------------------------------------
ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_status_check;
ALTER TABLE plugins ADD CONSTRAINT plugins_status_check
  CHECK (status IN ('draft','awaiting_activation','active','disabled','rejected','failed'));

ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS rejected_by uuid NULL REFERENCES actors(id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason text NULL;
