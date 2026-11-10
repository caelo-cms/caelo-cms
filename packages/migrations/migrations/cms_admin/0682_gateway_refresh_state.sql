-- SPDX-License-Identifier: MPL-2.0
--
-- 0682 — the admin's refresh pings to the public API gateways.
--
-- After a publish that wrote a gateway's public database, the admin sends
-- that gateway one authenticated request, so a gateway that idles on
-- request-billed CPU, its feature off, reads its published state again
-- (admin-core gateway-refresh.ts, @caelo-cms/shared gateway-refresh.ts).
-- A failed ping never fails the publish; it is recorded here and shown
-- next to the gateway's other settings (Settings → Gateway,
-- `get_gateway_settings`).
--
-- One row per gateway (`live`, `staging`): the last attempt, where it went,
-- and the last success and failure. Expand-only: one new table. Runtime
-- bookkeeping, exempt from the change journal
-- (packages/shared/src/change-journal.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS gateway_refresh_state (
  target           text PRIMARY KEY CHECK (target IN ('live', 'staging')),
  url              text NULL CHECK (url IS NULL OR char_length(url) <= 2000),
  last_attempt_at  timestamptz NOT NULL,
  last_ok_at       timestamptz NULL,
  last_error       text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  last_error_at    timestamptz NULL,
  CHECK ((last_error IS NULL) = (last_error_at IS NULL))
);

ALTER TABLE gateway_refresh_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_refresh_state FORCE ROW LEVEL SECURITY;
-- The admin's publisher records its pings as the system actor; operators
-- and the AI read them (gateway.get_settings).
DROP POLICY IF EXISTS gateway_refresh_state_read ON gateway_refresh_state;
CREATE POLICY gateway_refresh_state_read ON gateway_refresh_state FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));
DROP POLICY IF EXISTS gateway_refresh_state_system ON gateway_refresh_state;
CREATE POLICY gateway_refresh_state_system ON gateway_refresh_state
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));

COMMIT;
