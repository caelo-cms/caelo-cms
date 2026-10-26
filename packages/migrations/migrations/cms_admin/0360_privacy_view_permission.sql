-- SPDX-License-Identifier: MPL-2.0
--
-- 0360 — the `privacy.view` permission: see visitors' personal data that plugins
-- record, e.g. the consent log (who consented to what, with a visitor id
-- and an IP hash). A plugin's admin panel that shows such data declares
-- this permission (`adminPanels[].permission`), so it is a decision of its
-- own, separate from managing settings or content.
--
-- Granted to the built-in owner role only. Custom roles may be given it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

INSERT INTO permissions (name, description) VALUES
  ('privacy.view', 'See visitors'' personal data that plugins record, e.g. the consent log')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.name = 'privacy.view'
ON CONFLICT DO NOTHING;

COMMIT;
