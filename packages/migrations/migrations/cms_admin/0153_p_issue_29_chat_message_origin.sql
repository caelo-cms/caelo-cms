-- SPDX-License-Identifier: MPL-2.0
--
-- 0153 — chat message provenance (issue #29).
--
-- Auto-injected chat messages (the crawl-completion nudge, post-approval
-- continuations) were persisted as role='user' rows and rendered with a
-- "You:" label, so they looked like the operator typed them. The DB role
-- enum stays user|assistant|tool — the model still needs to see these as
-- user turns — so provenance rides a separate nullable `origin` column
-- instead of a fourth role. origin='system' marks an auto-injected status
-- line; NULL (or 'operator') is a message the operator actually typed. The
-- editor renders system-origin rows as a muted, centered status note.
--
-- Plain column add on an already-RLS'd table; no policy change needed.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE chat_messages ADD COLUMN origin text;

COMMIT;
