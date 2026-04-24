-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 2.1: seed the system actor so `audit_events.actor_id` FK holds for
-- pre-authentication events (login attempts, failed logins, setup). The fixed
-- UUID is the same one `hooks.server.ts` uses for `SYSTEM_CTX.actorId`.

INSERT INTO actors (id, kind, display_name)
VALUES ('00000000-0000-0000-0000-00000000ffff'::uuid, 'system', 'Caelo System')
ON CONFLICT (id) DO NOTHING;
