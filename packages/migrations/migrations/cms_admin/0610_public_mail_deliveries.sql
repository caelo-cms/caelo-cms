-- SPDX-License-Identifier: MPL-2.0
--
-- 0610 — #1337 (epic #763 M7): the delivery ledger of the public mail
-- outboxes.
--
-- The admin drains each public database's `mail_outbox` (cms_public
-- migration 0610) and sends what passes its checks. The outbox is
-- attacker-writable, so how many mails a recipient and the whole site get
-- must be decided from state the public side cannot touch: one row here per
-- mail the admin decided to send, per environment. The caps
-- (admin-core `email/outbox.ts`) count these rows; a forged outbox can queue
-- any number of rows but never get more delivered than the caps allow.
--
-- No address is stored: `recipient_hash` is the SHA-256 of the normalised
-- address, enough to count per recipient. Rows older than the longest cap
-- window are collected by the drain itself.
--
-- This is not an outbox and nothing is derived from it besides the counts
-- (docs/dev/state-and-changes.md): a log, exempt from the change journal
-- (packages/shared/src/change-journal.ts). Expand-only: a new table.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS public_mail_deliveries (
  id              bigserial PRIMARY KEY,
  environment     text NOT NULL CHECK (environment IN ('live', 'staging')),
  recipient_hash  text NOT NULL CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
  plugin_id       uuid NOT NULL,
  template        text NOT NULL CHECK (template ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- `reserved` when the cap was taken, then `sent` or `failed` after the
  -- transport answered. A reserved row counts against the caps either way.
  outcome         text NOT NULL DEFAULT 'reserved' CHECK (outcome IN ('reserved', 'sent', 'failed')),
  message_id      text NULL CHECK (char_length(message_id) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The caps count by environment and window (site-wide) and by environment,
-- recipient and window (per recipient); the GC deletes by age.
CREATE INDEX IF NOT EXISTS public_mail_deliveries_env_created_idx
  ON public_mail_deliveries (environment, created_at);
CREATE INDEX IF NOT EXISTS public_mail_deliveries_recipient_idx
  ON public_mail_deliveries (environment, recipient_hash, created_at);
CREATE INDEX IF NOT EXISTS public_mail_deliveries_created_idx
  ON public_mail_deliveries (created_at);

ALTER TABLE public_mail_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_mail_deliveries FORCE ROW LEVEL SECURITY;
-- Only the system actor drains the outboxes (the ops are system-only).
DROP POLICY IF EXISTS public_mail_deliveries_system ON public_mail_deliveries;
CREATE POLICY public_mail_deliveries_system ON public_mail_deliveries
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));

COMMIT;
