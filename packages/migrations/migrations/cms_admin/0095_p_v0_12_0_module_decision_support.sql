-- SPDX-License-Identifier: MPL-2.0
--
-- 0095 — Decision-support metadata for modules + content_instances.
--
-- Per CLAUDE.md §1A: every domain object the AI might reach for ships
-- with decision-support context, not just identity. This migration
-- adds the metadata the AI needs to pick the right module / content
-- instance without asking the operator a question:
--
--   modules.description   — what this module is for + when to use it
--   modules.kind          — chrome | hero | content | cta | utility
--   content_instances.purpose — why this row exists as a shared row
--
-- All three are additive. Existing rows are backfilled with safe
-- defaults so legacy callers (82+ modules.create call sites) keep
-- working; the AI tool descriptions enforce that AI authors must
-- supply description + kind explicitly going forward.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- ─── modules.description + modules.kind ──────────────────────────────

ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'content';

-- CHECK constraint matches the AI-facing tag set. Adding a new kind
-- means: (1) bump this CHECK, (2) update moduleKindSchema in
-- packages/shared/src/content.ts, (3) update the `## Modules` block
-- so the AI knows when to use it.
ALTER TABLE modules
  DROP CONSTRAINT IF EXISTS modules_kind_check;
ALTER TABLE modules
  ADD CONSTRAINT modules_kind_check
  CHECK (kind IN ('chrome', 'hero', 'content', 'cta', 'utility'));

-- Backfill description from display_name so existing modules have
-- a usable hint until the operator (or AI) rewrites it.
UPDATE modules
  SET description = display_name
  WHERE description = '' AND display_name IS NOT NULL;

-- Infer kind for existing modules. A module that's referenced by any
-- layout_modules row IS chrome (header/footer/nav); everything else
-- stays the default 'content'. The operator can re-classify later
-- via modules.update.
UPDATE modules m
  SET kind = 'chrome'
  WHERE kind = 'content'
    AND EXISTS (
      SELECT 1 FROM layout_modules lm
      WHERE lm.module_id = m.id
    );

-- ─── content_instances.purpose ───────────────────────────────────────

ALTER TABLE content_instances
  ADD COLUMN IF NOT EXISTS purpose text;

-- No backfill — `purpose` is intentionally nullable. The migration that
-- introduces content_instances (0093) created one private CI per
-- existing placement; those have NO shared-reuse semantics so leaving
-- `purpose IS NULL` is correct. Shared CIs minted post-0095 carry
-- their authoring rationale.

COMMIT;
