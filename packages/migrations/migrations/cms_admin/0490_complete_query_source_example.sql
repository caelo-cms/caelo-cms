-- SPDX-License-Identifier: MPL-2.0
--
-- 0490 — issues #1281 / #1304: the overview example in the skills is a
-- complete page query.
--
-- 0418 taught `source:{kind:"query", defaults:{page_type:"<slug>"}}` — no
-- `order`, no `limit`. A module built from it rendered nothing but a
-- `list-malformed` marker, and `preview_list_source` refused it. Module
-- and list-type writes now refuse such a source; the example in
-- manage-page-types and compose-page shows the complete shape instead.
--
-- replace() is a no-op once the text is gone, so the migration is
-- idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  $old$source:{kind:"query", defaults:{page_type:"<slug>"}}$old$,
  $new$source:{kind:"query", defaults:{page_type:"<slug>", order:"published_desc", limit:50}}$new$
)
WHERE slug IN ('manage-page-types', 'compose-page')
  AND body LIKE '%source:{kind:"query", defaults:{page_type:"<slug>"}}%';

COMMIT;
