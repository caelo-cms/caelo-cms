-- SPDX-License-Identifier: MPL-2.0
--
-- 0620 — #1460: the Owner's choice to run this install without an AI key,
-- through Power-MCP only.
--
-- "No key" has to be a stored, deliberate state: an absent provider row
-- reads the same on a fresh install that has not decided yet (the first-run
-- gate sends the Owner to /welcome/ai) as on one whose Owner decided it needs
-- no key. So the choice is a row of its own (CLAUDE.md §2: no fallback at
-- read time): one row means the Owner chose it, no row means they did not.
--
-- Written by `ai_providers.set_mcp_only` (human-only, audited). Storing a key
-- removes the row in the same transaction (`ai_providers.set`), so adding a
-- key ends the mode without a further step. Removing the last key never
-- writes the row, so it cannot switch the mode on silently.
--
-- Read per request and per provider resolution, nothing derived from it:
-- exempt from the change journal, like ai_providers
-- (packages/shared/src/change-journal.ts).
--
-- Expand-only: a new table. The previous image never reads it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS mcp_only_mode (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chosen_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mcp_only_mode ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_only_mode FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_only_mode_read ON mcp_only_mode;
CREATE POLICY mcp_only_mode_read ON mcp_only_mode FOR SELECT
  USING (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system']));
DROP POLICY IF EXISTS mcp_only_mode_insert ON mcp_only_mode;
CREATE POLICY mcp_only_mode_insert ON mcp_only_mode FOR INSERT
  WITH CHECK (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system']));
DROP POLICY IF EXISTS mcp_only_mode_delete ON mcp_only_mode;
CREATE POLICY mcp_only_mode_delete ON mcp_only_mode FOR DELETE
  USING (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'system']));

COMMIT;
