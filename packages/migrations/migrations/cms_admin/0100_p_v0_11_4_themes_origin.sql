-- SPDX-License-Identifier: MPL-2.0
-- v0.11.4 (issue #76 follow-up) — record where a theme's current state
-- came from so the AI knows when it's looking at an untouched starter
-- palette vs. something a human or another AI turn already shaped.
--
-- Background: 0099 populated the empty `site-default` row with the
-- shadcn-default preset (neutral grayscale) so the Themes admin UI
-- looks real on a fresh install. Side effect: the AI now sees an
-- "active theme" exists and inherits its grayscale into module CSS
-- instead of free-styling. Without an explicit signal that this is a
-- seed (not an operator's brand choice), the AI has no reason to
-- propose evolving it for the site being built.
--
-- `origin` is the signal:
--   'seed'     — populated by migration 0099 or by a fresh install
--   'ai'       — last edit was made by an AI actor
--   'operator' — last edit was made by a human actor (admin UI or API)
--
-- One-way transitions after creation: 'seed' → 'ai'|'operator', and
-- 'ai' ↔ 'operator' (whichever actor wrote most recently). Handlers
-- in admin-core/ops/themes.ts and themes_pending.ts flip the column
-- in the same tx as the write, so the value reflects the actor of the
-- most recent token / meta / asset edit.
--
-- This migration also widens the snapshot op_kind CHECK to admit
-- 'themes.update_meta' (the new op that updates description/displayName
-- without touching tokens — same revert semantics as update_tokens).

ALTER TABLE themes
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'seed'
    CHECK (origin IN ('seed', 'ai', 'operator'));

COMMENT ON COLUMN themes.origin IS
  'Provenance of the current state: seed (untouched starter) | ai | operator. '
  'Flipped by write handlers based on ExecutionContext.actorKind. '
  'AI uses this signal to decide whether to evolve the theme for the site being built.';

-- Backfill existing rows. On a fresh install the seed row was inserted
-- by 0097 with `tokens = '{}'` and (when 0099 runs) populated; either
-- way the originating actor was the migration runner (system), and no
-- live edit has happened yet — `'seed'` is correct.
--
-- On older installs that have been edited post-0097, the column lands
-- with the wrong value (default `'seed'`) until the next edit flips it.
-- We accept that one-edit lag: the alternative would be a heuristic
-- ("if updated_at > created_at, guess operator") that no-fallbacks
-- (CLAUDE.md §2) explicitly rejects. The next write self-corrects.
UPDATE themes SET origin = 'seed' WHERE origin IS NULL;

-- Snapshot op_kind: admit themes.update_meta (new op landing in the
-- same PR as this migration). Mirrors the 0098 widen pattern.
ALTER TABLE site_snapshots
  DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create',
    'modules.update',
    'modules.delete',
    'templates.create',
    'templates.update',
    'templates.delete',
    'template_blocks.set',
    'pages.create',
    'pages.update',
    'pages.set_modules',
    'pages.delete',
    'snapshots.revert_site',
    'snapshots.revert_module',
    'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish',
    'chat.merge_to_main',
    'chat.stage',
    'chat.unstage',
    'layout_modules.set',
    'page_module_content.set',
    'structured_sets.set',
    'redirects.create',
    'redirects.update',
    'redirects.delete',
    'content_instances.create',
    'content_instances.set_values',
    'content_instances.delete',
    'placement.set_content',
    'placement.fork_content',
    'unknown',
    'themes.update_tokens',
    'themes.set_asset',
    'themes.duplicate',
    'themes.import_dtcg',
    'themes.import',
    'themes.activate',
    -- v0.11.4 (issue #76 follow-up): description / displayName edits.
    'themes.update_meta'
  ));
