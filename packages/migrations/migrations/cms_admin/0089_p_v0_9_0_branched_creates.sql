-- SPDX-License-Identifier: MPL-2.0

-- v0.9.0 — Branched-create with same-chat read visibility + cross-chat
-- write-block. Completes the v0.5.x chat-branched-writes retrofit that
-- was started for updates (v0.5.0-v0.5.3) and attempted for pages.create
-- in v0.5.7 (then reverted in v0.5.19 because the read overlays weren't
-- finished). v0.9.0 finishes both halves:
--
--   - schema-side (this migration): add chat_branch_id column to every
--     primary content table; per-branch slug uniqueness so two chats
--     can both pick the same slug for their in-flight creates.
--   - code-side (the rest of v0.9.0): branch-aware list/get reads so a
--     chat sees its own branched creates; main-only static-gen so
--     production never ships an unpromoted entity; merge clears the
--     branch_id on chat.merge_to_main / chat.publish to graduate.
--
-- The model: chat_branch_id IS NULL = main (visible to all chats +
-- static-gen). chat_branch_id = <branch> = branched to that one chat
-- only (visible in same-chat reads + iframe preview; invisible to other
-- chats; invisible to static-gen). On merge, UPDATE ... SET
-- chat_branch_id = NULL graduates the entity.
--
-- No FK to chat_sessions.chat_branch_id — chat lifecycle (archive,
-- hard-delete) doesn't cascade through here. Orphan cleanup is a
-- v0.9.x worker job.
--
-- Slug uniqueness: the old UNIQUE constraints would reject any branched
-- create that picks an in-use slug, breaking the "every chat builds a
-- hero module" workflow. Replace with partial UNIQUE INDEX scoped by
-- COALESCE(chat_branch_id, sentinel-uuid) so each branch has its own
-- slug namespace + main has its own. Merge collisions surface as
-- structured MergeCollision errors that the AI translates into a
-- rename + retry.
--
-- Migration safety: adding NULL columns + small partial indexes is
-- online. Replacing the UNIQUE constraints with UNIQUE INDEXes is a
-- brief DROP CONSTRAINT + CREATE INDEX pair per table — acceptable
-- writer-block window during the v0.9 upgrade.

-- Column adds (online, no table lock).
ALTER TABLE modules   ADD COLUMN chat_branch_id UUID NULL;
ALTER TABLE templates ADD COLUMN chat_branch_id UUID NULL;
ALTER TABLE layouts   ADD COLUMN chat_branch_id UUID NULL;
ALTER TABLE pages     ADD COLUMN chat_branch_id UUID NULL;

-- Partial indexes — only branched rows are indexed (main is the
-- default path; queries with chat_branch_id IS NULL hit the primary
-- key directly).
CREATE INDEX modules_chat_branch_idx   ON modules   (chat_branch_id) WHERE chat_branch_id IS NOT NULL;
CREATE INDEX templates_chat_branch_idx ON templates (chat_branch_id) WHERE chat_branch_id IS NOT NULL;
CREATE INDEX layouts_chat_branch_idx   ON layouts   (chat_branch_id) WHERE chat_branch_id IS NOT NULL;
CREATE INDEX pages_chat_branch_idx     ON pages     (chat_branch_id) WHERE chat_branch_id IS NOT NULL;

-- Slug uniqueness — drop the old single-column UNIQUE; replace with a
-- branch-scoped partial UNIQUE INDEX. Sentinel '00000000-0000-0000-
-- 0000-000000000000' stands in for "main" so multiple NULLs become a
-- single value Postgres treats as collidable.
--
-- WHERE deleted_at IS NULL — soft-deleted rows free their slug for
-- reuse. Matches the existing implicit behavior (the old UNIQUE
-- constraint didn't have the filter, so soft-deleted rows blocked
-- their slug — a real pre-existing footgun this migration also fixes).

ALTER TABLE modules DROP CONSTRAINT modules_slug_key;
CREATE UNIQUE INDEX modules_slug_branch_uidx
  ON modules (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

ALTER TABLE templates DROP CONSTRAINT templates_slug_key;
CREATE UNIQUE INDEX templates_slug_branch_uidx
  ON templates (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

ALTER TABLE layouts DROP CONSTRAINT layouts_slug_key;
CREATE UNIQUE INDEX layouts_slug_branch_uidx
  ON layouts (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

-- Pages already used (slug, locale) as the composite key; extend with
-- chat_branch_id.
ALTER TABLE pages DROP CONSTRAINT pages_slug_locale_unique;
CREATE UNIQUE INDEX pages_slug_locale_branch_uidx
  ON pages (slug, locale, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;
