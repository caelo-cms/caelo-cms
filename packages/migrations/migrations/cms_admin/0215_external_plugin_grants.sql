-- SPDX-License-Identifier: MPL-2.0
-- Immutable external artifacts and Owner capability receipts. Pending updates
-- do not overwrite the currently running plugin's source or permissions.

-- Moderation permission plugins.approve is deliberately insufficient.
INSERT INTO permissions (name, description) VALUES ('plugins.install', 'Approve external plugin installations and revoke their capabilities') ON CONFLICT (name) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'owner' AND p.name = 'plugins.install' ON CONFLICT DO NOTHING;

CREATE FUNCTION can_approve_plugin_installation() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('caelo.actor_kind', true) = 'system' OR
    (current_setting('caelo.actor_kind', true) = 'human' AND EXISTS (
      SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
        AND u.deleted_at IS NULL AND p.name = 'plugins.install'));
$$;

CREATE TABLE plugin_installation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  manifest_json jsonb NOT NULL,
  source_code text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('external-package', 'runtime-authored')),
  sdk_api_version integer NOT NULL DEFAULT 1 CHECK (sdk_api_version = 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'active', 'retired', 'rejected')),
  expected_state_digest text,
  approved_by uuid REFERENCES actors(id),
  approved_at timestamptz,
  submitted_by uuid NOT NULL REFERENCES actors(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, artifact_digest)
);
ALTER TABLE plugin_installation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_installation_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_versions_read ON plugin_installation_versions FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('system', 'human', 'ai'));
CREATE POLICY plugin_versions_stage ON plugin_installation_versions FOR INSERT
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('system', 'human', 'ai')
    AND status = 'pending' AND approved_by IS NULL AND approved_at IS NULL AND expected_state_digest IS NULL AND submitted_by = NULLIF(current_setting('caelo.actor_id', true), '')::uuid);
CREATE POLICY plugin_versions_decide ON plugin_installation_versions FOR UPDATE
  USING (can_approve_plugin_installation())
  WITH CHECK (can_approve_plugin_installation());

CREATE FUNCTION prevent_plugin_artifact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.plugin_id, NEW.artifact_digest, NEW.manifest_json, NEW.source_code, NEW.origin,
      NEW.sdk_api_version, NEW.submitted_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.plugin_id, OLD.artifact_digest, OLD.manifest_json, OLD.source_code, OLD.origin,
      OLD.sdk_api_version, OLD.submitted_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Plugin artifacts are immutable; stage a new version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plugin_artifact_immutable BEFORE UPDATE ON plugin_installation_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_plugin_artifact_mutation();

CREATE TABLE plugin_capability_grants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_id uuid NOT NULL,
  artifact_digest text NOT NULL,
  capability text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid NOT NULL REFERENCES actors(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES actors(id),
  FOREIGN KEY (plugin_id, artifact_digest)
    REFERENCES plugin_installation_versions(plugin_id, artifact_digest) ON DELETE CASCADE,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX plugin_current_grants ON plugin_capability_grants(plugin_id, artifact_digest, capability)
  WHERE revoked_at IS NULL;
ALTER TABLE plugin_capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_capability_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_grants_read ON plugin_capability_grants FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('system', 'human'));
CREATE POLICY plugin_grants_owner_insert ON plugin_capability_grants FOR INSERT WITH CHECK (
  can_approve_plugin_installation() AND revoked_at IS NULL AND revoked_by IS NULL AND
  (current_setting('caelo.actor_kind', true) = 'system' OR approved_by = NULLIF(current_setting('caelo.actor_id', true), '')::uuid)
);
CREATE POLICY plugin_grants_owner_revoke ON plugin_capability_grants FOR UPDATE
  USING (can_approve_plugin_installation())
  WITH CHECK (can_approve_plugin_installation() AND
    (current_setting('caelo.actor_kind', true) = 'system' OR revoked_by = NULLIF(current_setting('caelo.actor_id', true), '')::uuid));

CREATE FUNCTION prevent_plugin_grant_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.plugin_id, NEW.artifact_digest, NEW.capability, NEW.constraints, NEW.approved_by, NEW.approved_at)
    IS DISTINCT FROM (OLD.id, OLD.plugin_id, OLD.artifact_digest, OLD.capability, OLD.constraints, OLD.approved_by, OLD.approved_at)
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Capability receipts are immutable; revoke and issue a new receipt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plugin_grant_immutable BEFORE UPDATE ON plugin_capability_grants
  FOR EACH ROW EXECUTE FUNCTION prevent_plugin_grant_rewrite();
