-- SPDX-License-Identifier: MPL-2.0
--
-- 0108 — Design Manifest storage (issue #165, epic #149).
--
-- Single latest-wins row (like site_defaults): the manifest describes
-- the CURRENT design system; history rides the audit log. Chat-branch
-- semantics are deferred with the compiler's later slices — the
-- manifest is written at materialisation time, which already happens
-- on the operator-approved path.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE design_manifests (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES actors(id)
);

ALTER TABLE design_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS design_manifests_authenticated_scope ON design_manifests;
CREATE POLICY design_manifests_authenticated_scope ON design_manifests
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- site-genesis materialise step gains the manifest write. Guarded:
-- only when the (c) step is absent — operator edits win; re-runs no-op.
UPDATE skills
SET body = body || '

After materialising, write the Design Manifest: `set_design_manifest` with the token ROLES you just decided (which var is for CTAs, which surfaces alternate), the typography + rhythm rules, and one pattern entry per section type you built (name + module type + one-line spec). Every future page follows this manifest — it is how page B stays on page A''s line.'
WHERE slug = 'site-genesis'
  AND body NOT LIKE '%set_design_manifest%';

COMMIT;
