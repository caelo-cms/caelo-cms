-- SPDX-License-Identifier: MPL-2.0
-- Generic immutable private bytes. Never included in media/CDN manifests.
CREATE TABLE plugin_private_files (
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  media_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, id)
);
CREATE TABLE plugin_private_file_chunks (
  plugin_id uuid NOT NULL,
  file_id uuid NOT NULL,
  offset_bytes integer NOT NULL CHECK (offset_bytes >= 0 AND offset_bytes % 262144 = 0),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 262144),
  PRIMARY KEY (plugin_id, file_id, offset_bytes),
  FOREIGN KEY (plugin_id, file_id) REFERENCES plugin_private_files(plugin_id, id) ON DELETE CASCADE
);
ALTER TABLE plugin_private_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_private_files FORCE ROW LEVEL SECURITY;
ALTER TABLE plugin_private_file_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_private_file_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY private_files_scope ON plugin_private_files FOR ALL
  USING (current_setting('caelo.actor_kind', true) = 'plugin'
    AND plugin_id = nullif(current_setting('caelo.plugin_id', true), '')::uuid)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'plugin'
    AND plugin_id = nullif(current_setting('caelo.plugin_id', true), '')::uuid);
CREATE POLICY private_file_chunks_scope ON plugin_private_file_chunks FOR ALL
  USING (current_setting('caelo.actor_kind', true) = 'plugin'
    AND plugin_id = nullif(current_setting('caelo.plugin_id', true), '')::uuid)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'plugin'
    AND plugin_id = nullif(current_setting('caelo.plugin_id', true), '')::uuid);
