-- SPDX-License-Identifier: MPL-2.0
--
-- 0357 — epic #1107 part G: list types a plugin ships.
--
-- A plugin's manifest may declare list types (`listTypes`). The host
-- stores them through `list_types.sync_plugin_types` when the plugin
-- loads, owned by the plugin: `plugin_id` names it. Like a plugin's
-- skills (0218/0219), such a type is available exactly while its plugin
-- is: `plugin_list_type_available` reads the Owner's status of the
-- plugin (and, for an externally installed plugin, the `list_types`
-- grant of the running artifact), so a disable archives the type
-- without the host writing a row, and the next activation brings it
-- back. Site-owned types keep `plugin_id` NULL and are always available.
--
-- ON DELETE SET NULL: uninstalling the plugin removes the plugin, not
-- the operator's lists of its types — the type then stays as a site type
-- the operator owns and may edit.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE list_types
  ADD COLUMN plugin_id uuid REFERENCES plugins(id) ON DELETE SET NULL;
CREATE INDEX list_types_plugin_idx ON list_types (plugin_id) WHERE plugin_id IS NOT NULL;

CREATE FUNCTION plugin_list_type_available(owner_plugin_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT owner_plugin_id IS NULL OR EXISTS (
    SELECT 1 FROM public.plugins p WHERE p.id = owner_plugin_id AND p.status = 'active'
      AND (p.tier = 1 OR EXISTS (
        SELECT 1 FROM public.plugin_installation_versions v
        JOIN public.plugin_capability_grants g
          ON g.plugin_id = v.plugin_id AND g.artifact_digest = v.artifact_digest
        WHERE v.plugin_id = p.id AND v.status = 'active'
          AND p.manifest_json = v.manifest_json AND p.source_code = v.source_code
          AND g.capability = 'list_types' AND g.revoked_at IS NULL
      ))
  );
$$;

COMMIT;
