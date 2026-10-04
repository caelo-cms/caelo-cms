-- SPDX-License-Identifier: MPL-2.0
-- Declarative companion skills belong to the reviewed external artifact.
ALTER TABLE skills ADD COLUMN plugin_artifact_digest text
  CHECK (plugin_artifact_digest IS NULL OR plugin_artifact_digest ~ '^[a-f0-9]{64}$');
-- Retains namespace ownership when uninstall's FK clears plugin_id.
ALTER TABLE skills ADD COLUMN plugin_owner_slug text;

-- Receipt metadata is readable to AI actors so skill availability can be
-- checked under the caller's existing RLS context. Granting and revoking remain
-- Owner-only; this does not expose private plugin storage or approval bindings.
ALTER POLICY plugin_grants_read ON plugin_capability_grants
  USING (current_setting('caelo.actor_kind', true) IN ('system', 'human', 'ai'));

CREATE FUNCTION plugin_skill_available(owner_plugin_id uuid, artifact_digest text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN owner_plugin_id IS NULL THEN artifact_digest IS NULL ELSE EXISTS (
    SELECT 1 FROM public.plugins p WHERE p.id = owner_plugin_id AND p.status = 'active'
      AND (p.tier = 1 OR EXISTS (
        SELECT 1 FROM public.plugin_installation_versions v
        JOIN public.plugin_capability_grants g
          ON g.plugin_id = v.plugin_id AND g.artifact_digest = v.artifact_digest
        WHERE v.plugin_id = p.id AND v.status = 'active'
          AND v.artifact_digest = $2
          AND p.manifest_json = v.manifest_json AND p.source_code = v.source_code
          AND g.capability = 'companion_skills' AND g.revoked_at IS NULL
      ))
  ) END;
$$;
