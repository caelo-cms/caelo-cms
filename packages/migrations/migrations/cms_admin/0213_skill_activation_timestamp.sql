-- SPDX-License-Identifier: MPL-2.0
--
-- skills.activated_at — when a skill BECAME available to the AI.
--
-- The `## Skills` index is a cached system-prompt prefix. Rebuilding it
-- from live rows on every turn means an activation mid-chat rewrites
-- the prefix and busts the cache from that point on, for the rest of
-- the chat (CLAUDE.md §11 — nothing that changes turn-to-turn belongs
-- in the system prompt). So the index is pinned to what was active when
-- the chat started, and a chat that is already running learns about a
-- newly activated skill through a notice appended to its message
-- history instead.
--
-- Both halves need to know WHEN a skill became available, and neither
-- existing column answers it: `created_at` is when the row was written
-- (an awaiting_activation skill can sit there for weeks) and
-- `updated_at` moves on any edit, so a reworded body would read as a
-- fresh activation and re-fire the notice.
--
-- Backfill: every already-active skill gets `created_at`, which is the
-- best evidence available and is in the past for every existing chat —
-- so no chat retroactively sees a notice for a skill it always had.
-- NULL means "not currently active"; the deactivation paths clear it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE skills ADD COLUMN IF NOT EXISTS activated_at timestamptz NULL;

UPDATE skills SET activated_at = created_at
 WHERE status = 'active' AND activated_at IS NULL;

-- The index the per-chat pin reads: "active skills, ordered by when
-- they became active". Partial — inactive rows are never in the index.
CREATE INDEX IF NOT EXISTS skills_activated_at_idx
  ON skills (activated_at)
  WHERE status = 'active';

COMMIT;
