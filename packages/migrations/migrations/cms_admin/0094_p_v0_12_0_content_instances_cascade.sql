-- SPDX-License-Identifier: MPL-2.0

-- v0.12.0 follow-up — change content_instances.module_id FK to
-- ON DELETE CASCADE so hard-deleting a module also clears its
-- content_instances rows.
--
-- Production write paths (modules.delete) soft-delete the module
-- (sets deleted_at) and never fire this FK — so this CASCADE only
-- matters for two cases:
--
--   1. Test teardown that issues `DELETE FROM modules WHERE id = X`
--      to wipe fixtures between runs. Without CASCADE, the module
--      delete fails on the content_instances FK (the test seeded
--      a content_instance per page_modules row, and 0093's NOT NULL
--      means there's always at least one referencer).
--   2. Hard-recovery scripts that bypass the soft-delete path. Same
--      shape: orphan content_instances become unreachable but block
--      the module delete unless cascaded.
--
-- The other FK — page_modules.content_instance_id REFERENCES
-- content_instances(id) ON DELETE RESTRICT — stays unchanged. Per
-- the v0.12 design (CLAUDE.md §11.A), a hard delete of a content
-- instance that has placements referencing it is intentionally
-- refused. The cascade we're adding here can still trip that RESTRICT
-- when a module's deletion would orphan a content_instance whose
-- page_modules row hasn't been cleaned up first — which is the
-- correct fail-loud behaviour (the test forgot to delete pages first).

ALTER TABLE content_instances
  DROP CONSTRAINT IF EXISTS content_instances_module_id_fkey;
ALTER TABLE content_instances
  ADD CONSTRAINT content_instances_module_id_fkey
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;
