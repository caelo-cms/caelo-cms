-- SPDX-License-Identifier: MPL-2.0
-- Preserve ownership for release-signed guides as well as external companions.
UPDATE skills s SET plugin_owner_slug = p.slug
FROM plugins p WHERE s.plugin_id = p.id;

DROP FUNCTION plugin_skill_available(uuid, text);

CREATE FUNCTION plugin_skill_available(owner_plugin_id uuid, artifact_digest text, owner_slug text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN owner_plugin_id IS NULL THEN artifact_digest IS NULL AND owner_slug IS NULL ELSE EXISTS (
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
