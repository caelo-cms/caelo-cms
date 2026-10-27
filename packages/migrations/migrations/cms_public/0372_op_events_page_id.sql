-- SPDX-License-Identifier: MPL-2.0
--
-- 0372 — issue #1155: a visitor op event may name the page it changed.
--
-- A plugin declares in its manifest which operations change what it bakes
-- into pages, and where the page id is (plugin SDK `bakedData`). When a
-- visitor calls such an operation, the gateway records that one page id
-- with the op event. The admin reads it back as an UNTRUSTED hint for the
-- plugin-data build (docs/dev/public-admin-boundary.md): it counts only for
-- a declared trigger of a plugin the admin runs and a page that exists in
-- cms_admin, and it only schedules a re-bake from authoritative state. A
-- forged row can at most make the admin re-render a page whose output is
-- the same; it can never change cms_admin or what a page shows.
--
-- public_role may insert the column like the other payload columns (0280);
-- it still cannot read the table back.
--
-- Not a contract migration: the column is nullable, and the previous
-- gateway inserts without it.

ALTER TABLE gateway_plugin_op_events ADD COLUMN IF NOT EXISTS page_id uuid NULL;

GRANT INSERT (page_id) ON gateway_plugin_op_events TO public_role;
