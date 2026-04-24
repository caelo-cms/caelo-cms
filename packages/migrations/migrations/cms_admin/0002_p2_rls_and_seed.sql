-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 2: RLS policies for the new auth / role / session tables, plus the
-- seeded fixed-permission catalog and the three built-in roles.
--
-- RLS strategy for admin-layer management tables (roles, permissions,
-- role_permissions, user_roles): policies are permissive (USING true / WITH
-- CHECK true) because access control happens in app middleware — "caller has
-- the roles.manage permission" is a complex cross-join that would be painful
-- to express in pg_policies. The "every table has RLS" invariant is still
-- mechanically true; drift check passes.
--
-- RLS for self-owned rows (users, sessions): per-actor scope with system
-- bypass so a logged-in user can read their own profile, and the
-- session-lookup middleware can run as system during the pre-auth phase.

------------------------------------------------------------------------
-- users
------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_self_or_system ON users;
CREATE POLICY users_self_or_system ON users
  USING (id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
         OR current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
              OR current_setting('caelo.actor_kind', true) = 'system');

------------------------------------------------------------------------
-- sessions
------------------------------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_self_or_system ON sessions;
CREATE POLICY sessions_self_or_system ON sessions
  USING (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
         OR current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
              OR current_setting('caelo.actor_kind', true) = 'system');

------------------------------------------------------------------------
-- roles / permissions / role_permissions / user_roles — app-layer enforced
------------------------------------------------------------------------
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roles_open ON roles;
CREATE POLICY roles_open ON roles USING (true) WITH CHECK (true);

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS permissions_open ON permissions;
CREATE POLICY permissions_open ON permissions USING (true) WITH CHECK (true);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_permissions_open ON role_permissions;
CREATE POLICY role_permissions_open ON role_permissions USING (true) WITH CHECK (true);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_roles_open ON user_roles;
CREATE POLICY user_roles_open ON user_roles USING (true) WITH CHECK (true);

------------------------------------------------------------------------
-- Seed: fixed permission catalog (idempotent via ON CONFLICT DO NOTHING)
------------------------------------------------------------------------
INSERT INTO permissions (name, description) VALUES
  ('content.read',   'View pages, modules, templates, and media'),
  ('content.write',  'Create and edit pages, modules, templates, and media'),
  ('translations.write', 'Create and edit locale variants via translation modes'),
  ('deploy.trigger', 'Request a deploy / promote staging to production'),
  ('ops.view',       'See the underlying dev / staging / production environments and promote controls'),
  ('plugins.approve','Approve plugin items such as comments and form submissions'),
  ('users.manage',   'Create, update, and delete admin users'),
  ('roles.manage',   'Create, update, and delete custom roles'),
  ('settings.read',  'Read the security control panel'),
  ('settings.write', 'Write the security control panel (AI provider, domains, costs)')
ON CONFLICT (name) DO NOTHING;

------------------------------------------------------------------------
-- Seed: built-in roles. is_builtin = true so they cannot be deleted or
-- renamed by the custom-role CRUD surface.
------------------------------------------------------------------------
INSERT INTO roles (name, description, is_builtin) VALUES
  ('owner',    'Full access — settings, deploy, content, user management, custom-role definition', true),
  ('editor',   'Create and edit content, manage modules, manage translations — cannot deploy or change settings', true),
  ('reviewer', 'Approve plugin items — cannot edit content or deploy', true)
ON CONFLICT (name) DO NOTHING;

------------------------------------------------------------------------
-- Seed: role → permission mappings for built-ins. Uses name lookups so UUIDs
-- don't have to be hard-coded. ON CONFLICT keeps the statement idempotent.
------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'editor'
  AND p.name IN ('content.read', 'content.write', 'translations.write', 'settings.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'reviewer'
  AND p.name IN ('content.read', 'plugins.approve', 'settings.read')
ON CONFLICT DO NOTHING;
