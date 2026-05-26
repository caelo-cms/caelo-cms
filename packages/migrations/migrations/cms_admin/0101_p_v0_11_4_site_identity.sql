-- SPDX-License-Identifier: MPL-2.0
-- v0.11.4 (issue #76 follow-up) — capture site identity at onboarding
-- time so theme configuration is site-specific instead of a generic
-- placeholder.
--
-- Background: prior to this migration, /setup captures Owner identity
-- (email/password/displayName) and /onboarding flips a "tour seen"
-- flag. Neither captures site identity — site name, what the site is
-- for, who it's for. Result: the active theme is a generic shadcn
-- placeholder seeded by migration 0099. The chat-runner has to ask the
-- AI to evolve the palette mid-page-build, which is probabilistic and
-- non-deterministic.
--
-- This migration extends `site_defaults` with `site_name` +
-- `site_purpose` columns (nullable). The rewritten onboarding page
-- prompts the operator for these along with an optional brand color;
-- the submit action writes them here + drives `themes.update_tokens`
-- + `themes.update_meta` so the active theme lands with `origin =
-- 'operator'` AND a real brand-driven palette before the first chat
-- turn ever runs.
--
-- Both columns are nullable so:
--   - Pre-migration installs that haven't visited /onboarding yet
--     still satisfy the schema.
--   - Operators who skip the optional questions (skip-button on the
--     identity step) still complete onboarding.
-- The chat-runner's `## Site identity` block renders only when at
-- least one of the columns is populated.

ALTER TABLE site_defaults
  ADD COLUMN IF NOT EXISTS site_name    TEXT,
  ADD COLUMN IF NOT EXISTS site_purpose TEXT;

COMMENT ON COLUMN site_defaults.site_name IS
  'Operator-supplied name of the site (used in the system-prompt # Site identity block + theme.displayName).';
COMMENT ON COLUMN site_defaults.site_purpose IS
  'Operator-supplied 1-2 sentence description of what the site is for and who it is for. Drives the AI''s brand context for every chat turn.';
