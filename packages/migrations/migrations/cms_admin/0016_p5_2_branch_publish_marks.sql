-- SPDX-License-Identifier: MPL-2.0
--
-- P5.2 #5 — partial publish bookkeeping. One row per (branch, entity)
-- pair recording which branch entities have been merged into main so a
-- subsequent `chat.publish` call (with no entity filter) only picks up
-- the entities that haven't shipped yet.

CREATE TABLE chat_branch_publish_marks (
  chat_branch_id    uuid NOT NULL,
  entity_kind       text NOT NULL CHECK (entity_kind IN ('module','template','page','pageLayout')),
  entity_id         uuid NOT NULL,
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  marked_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_branch_id, entity_kind, entity_id, site_snapshot_id)
);

CREATE INDEX chat_branch_publish_marks_lookup
  ON chat_branch_publish_marks (chat_branch_id, entity_kind, entity_id);

ALTER TABLE chat_branch_publish_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_branch_publish_marks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_branch_publish_marks_authenticated_scope ON chat_branch_publish_marks;
CREATE POLICY chat_branch_publish_marks_authenticated_scope ON chat_branch_publish_marks
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
