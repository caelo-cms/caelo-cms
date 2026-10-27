-- SPDX-License-Identifier: MPL-2.0
--
-- 0376 — #1156: skill guidance for SEO as draft state.
--
-- Page SEO no longer writes live (0375): an SEO edit is a pending change
-- of the page, staged and published with it. Two seeded skills said or
-- implied otherwise:
--
--   * fix-quality-findings — "SEO texts are written live" justified an
--     empty re-Stage; an SEO fix is now in the draft like any other fix.
--   * page-seo — says when an SEO edit reaches the site and that Undo of
--     the chat drops it, so the AI does not tell the operator it is live.
--
-- Surgical replaces guarded by the exact old text: an operator-edited
-- body is left alone.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'Stage again yourself with `stage_changes` (it rebuilds staging even when the fix changed nothing in the draft — SEO texts are written live) and tell the operator',
     'Stage again yourself with `stage_changes` (it rebuilds staging even when the fix changed nothing in the draft) and tell the operator'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%(it rebuilds staging even when the fix changed nothing in the draft — SEO texts are written live)%';

UPDATE skills
   SET body = replace(
     body,
     '- bulk_optimize_seo takes every page of a pass in one call (`items`, one shared `context`) — never one call per page.',
     '- bulk_optimize_seo takes every page of a pass in one call (`items`, one shared `context`) — never one call per page.
- Every SEO edit is a draft change of its page, like a title edit: it shows in this chat''s open changes, reaches the live site only with the next Stage and the operator''s Publish live, and undoing the chat drops it. Never tell the operator an SEO change is live before that.'
   )
 WHERE slug = 'page-seo'
   AND body LIKE '%- bulk_optimize_seo takes every page of a pass in one call (`items`, one shared `context`) — never one call per page.%'
   AND body NOT LIKE '%Every SEO edit is a draft change of its page%';

COMMIT;
