-- SPDX-License-Identifier: MPL-2.0
--
-- 0250 — reconnecting a stuck Firebase Hosting custom domain joins the
-- domain pending queue.
--
-- A gcp-firebase custom domain created while DNS still pointed at the old
-- host can stay HOST_MISMATCH / OWNERSHIP_PENDING for hours after DNS is
-- fixed: Firebase stops re-checking. Deleting and re-creating it heals it.
-- That deletes the hosting binding of a hostname, so it is a §11.A action:
-- the AI proposes (`domains.propose_reconnect`), the operator approves in
-- the chat, and `domains.execute_proposal` runs `domains.reconnect_hosting`.
-- `domain_id` stays NULL when the hostname is not in `domains` (the stack
-- creates the apex custom domain without registering it there).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE domain_pending_actions DROP CONSTRAINT IF EXISTS domain_pending_actions_kind_check;
ALTER TABLE domain_pending_actions
  ADD CONSTRAINT domain_pending_actions_kind_check
  CHECK (kind IN ('add', 'remove', 'reconnect'));

COMMIT;
