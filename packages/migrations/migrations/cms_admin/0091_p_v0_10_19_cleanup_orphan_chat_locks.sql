-- SPDX-License-Identifier: MPL-2.0
--
-- v0.10.19 — One-time cleanup of orphan per-entity locks left behind
-- by pre-v0.10.19 `chat.merge_to_main` (Stage) calls.
--
-- Pre-v0.10.19, only chat.publish and chat.archive_session called
-- releaseChatLocks. chat.merge_to_main (Stage) merged branched edits
-- into main + stamped last_staged_at but left lock rows behind, so a
-- chat that had Staged everything still held locks on the entities it
-- once edited — blocking every other chat from touching the same
-- pages/modules with the error "page X is busy in another chat
-- ('<title>') — finish that chat (Stage + Publish)". The operator's
-- Stage button is hidden once last_staged_at catches up to the latest
-- snapshot (nothing pending), so there's no in-product affordance to
-- release the orphan. The code fix (release locks at merge_to_main)
-- closes the leak; this migration cleans up the historical damage.
--
-- "Orphan" definition: a lock row whose holder chat has staged at
-- least once (last_staged_at IS NOT NULL) AND has no snapshots
-- created strictly after its last Stage — i.e. the chat's branch is
-- entirely merged into main, so the lock has no protective purpose.
--
-- Idempotent: on future v0.10.19+ installs the WHERE clause matches
-- zero rows (v0.10.19's release-on-merge prevents the orphan class).
DELETE FROM chat_entity_locks
WHERE chat_session_id IN (
  SELECT cs.id
  FROM chat_sessions cs
  WHERE cs.last_staged_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM site_snapshots ss
      WHERE ss.chat_branch_id = cs.chat_branch_id
        AND ss.created_at > cs.last_staged_at
    )
);
