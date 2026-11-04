-- SPDX-License-Identifier: MPL-2.0
--
-- 0611 — #1337 (maintainer decision 2026-11-04): the delivery caps of the
-- public mail outboxes are Owner settings, not constants.
--
-- How many mails the admin sends from the public outboxes (0610) per
-- recipient and per hour is a money and abuse knob: a raised cap spends the
-- mail provider's quota and the sending domain's reputation before anyone
-- notices. So the AI only proposes a change (owner_settings
-- `set_mail_caps`, CLAUDE.md §11.A) and the Owner approves it; the Owner
-- panel writes it directly (`mail_caps.set`).
--
-- One row, seeded with the values the drain used until now. The drain reads
-- it on every run and fails loudly when it is missing (CLAUDE.md §2: stored
-- data, no read-time fallback). Read per drain, nothing derived: exempt from
-- the change journal (packages/shared/src/change-journal.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS mail_delivery_caps (
  id                         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Mails one recipient gets per environment within 24 hours.
  per_recipient_per_day      integer NOT NULL CHECK (per_recipient_per_day BETWEEN 1 AND 100),
  -- Mails the whole site sends per hour, live and staging.
  live_per_hour              integer NOT NULL CHECK (live_per_hour BETWEEN 1 AND 100000),
  staging_per_hour           integer NOT NULL CHECK (staging_per_hour BETWEEN 1 AND 10000),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid NULL REFERENCES actors(id) ON DELETE SET NULL
);

-- The FK's leading index (the FK index lint, #1293).
CREATE INDEX IF NOT EXISTS mail_delivery_caps_updated_by_idx ON mail_delivery_caps (updated_by);

INSERT INTO mail_delivery_caps (id, per_recipient_per_day, live_per_hour, staging_per_hour)
VALUES (1, 5, 200, 50)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE mail_delivery_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_delivery_caps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mail_delivery_caps_authenticated ON mail_delivery_caps;
CREATE POLICY mail_delivery_caps_authenticated ON mail_delivery_caps
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- One more action behind the owner-settings §11.A gate.
ALTER TABLE owner_settings_pending_actions
  DROP CONSTRAINT IF EXISTS owner_settings_pending_actions_kind_check;
ALTER TABLE owner_settings_pending_actions
  ADD CONSTRAINT owner_settings_pending_actions_kind_check
  CHECK (kind IN (
    'set_ai_budget',
    'set_ai_pricing',
    'set_gateway_settings',
    'set_translation_model',
    'set_plugin_ai_cost_cap',
    'rotate_gateway_cookie_secret',
    'set_staging_access',
    'rotate_staging_credentials',
    'set_staging_host',
    'set_mail_caps'
  ));

COMMIT;
