-- SPDX-License-Identifier: MPL-2.0
--
-- #1653 — one AI spend ledger for every paid call (plugin-host ai-ledger.ts).
--
-- ai_calls.reservation  'reserved' while the call runs (its worst-case cost
--                       is on the row, so every budget sum counts it),
--                       'settled' once its real cost is written, 'released'
--                       when it failed before the provider billed anything.
--                       Rows written before this release are settled.
-- ai_calls.spender      who pays, which decides the caps a call is checked
--                       against: 'actor' (a person's work: chat, subagents,
--                       core AI helpers), 'plugin' (a plugin's ctx.ai or
--                       images), 'plugin-visitor' (a plugin's visitor-facing
--                       AI, #1654, with its own daily cap).
--
-- Expand-only: two columns with defaults the previous release never reads,
-- so it keeps writing settled actor rows; plugin rows are marked below.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS reservation text NOT NULL DEFAULT 'settled';
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS spender text NOT NULL DEFAULT 'actor';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_calls_reservation_check') THEN
    ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_reservation_check
      CHECK (reservation IN ('reserved', 'settled', 'released'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_calls_spender_check') THEN
    ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_spender_check
      CHECK (spender IN ('actor', 'plugin', 'plugin-visitor'));
  END IF;
END $$;

-- A plugin's calls (text and images) were plugin spend all along.
UPDATE ai_calls SET spender = 'plugin' WHERE plugin_id IS NOT NULL AND spender = 'actor';

COMMIT;
