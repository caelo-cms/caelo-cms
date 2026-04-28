-- SPDX-License-Identifier: MPL-2.0
--
-- P6.6b — first-login onboarding state. Adds `users.onboarded_at`
-- so the post-login layout can redirect new users to /onboarding
-- once. The Owner created during initial setup gets `onboarded_at`
-- backfilled to created_at so the existing dev flow doesn't bounce
-- them through the tour on the first run after migration.

ALTER TABLE users ADD COLUMN onboarded_at timestamptz NULL;

-- Backfill: every existing user is treated as already-onboarded so
-- the tour only shows for users created post-migration.
UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL;
