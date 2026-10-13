-- SPDX-License-Identifier: MPL-2.0
--
-- 0261 — the admin's Security section is now Settings (issue #684).
--
-- Every Owner page moved from /security/* to /settings/*. The admin answers
-- the old paths with a permanent redirect, so stored links keep working —
-- but skill bodies are AI instructions, and an AI that tells the operator
-- "approve it at /security/layouts/pending" names a section the operator
-- no longer sees in the side nav. Rewrite the admin paths inside skill
-- bodies so the AI quotes the current location.
--
-- Older migrations that seeded these bodies stay untouched (they are
-- history); this rewrite runs once on top of whatever they produced,
-- including Owner-edited bodies — every "/security/" in a skill body is an
-- admin path, there is no other meaning of that string in skill text.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(body, '/security/', '/settings/')
WHERE body LIKE '%/security/%';

COMMIT;
