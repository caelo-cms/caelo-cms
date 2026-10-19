-- SPDX-License-Identifier: MPL-2.0
--
-- 0301 — the update policy without "off", plus the cloud-setup checkbox (#862).
--
-- Maintainer decisions 2026-10-19:
--
--   mode 'off' ("Don't tell me") is removed. It also suppressed the notice
--   of a security fix; security releases are always announced now. Every
--   stored 'off' becomes 'notify' (told about releases, installs by hand),
--   the closest remaining choice, and the CHECK no longer accepts 'off'.
--
--   auto_converge: the Owner allows releases that change the install's
--   Google Cloud project (infrastructure-contract bumps) to install on
--   their own. Default off. Inert until those releases can run from Caelo
--   (#819): the scheduler treats them as notify-only regardless.
--
-- Expand-safe: the previous release only reads 'notify' / 'auto' rows,
-- which it understands, and ignores the new defaulted column. Its one
-- write of 'off' (an Owner picking "Don't tell me" during the rollout
-- window) is refused by the CHECK with an error instead of storing a value
-- the new release cannot read. Inherits platform_update_policy's RLS and
-- the platform_updater role's table-level SELECT grant (0267).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE platform_update_policy SET mode = 'notify' WHERE mode = 'off';

ALTER TABLE platform_update_policy DROP CONSTRAINT IF EXISTS platform_update_policy_mode_check;
ALTER TABLE platform_update_policy
  ADD CONSTRAINT platform_update_policy_mode_check CHECK (mode IN ('notify', 'auto'));

ALTER TABLE platform_update_policy
  ADD COLUMN IF NOT EXISTS auto_converge boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN platform_update_policy.auto_converge IS
  'Owner allows releases that change the Google Cloud project to install automatically. Inert until #819: the scheduler treats them as notify-only.';

COMMIT;
