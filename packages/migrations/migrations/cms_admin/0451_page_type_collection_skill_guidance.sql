-- SPDX-License-Identifier: MPL-2.0
--
-- 0451 — the manage-page-types skill's two page-type examples state
-- `collection` (0450: a required field of every page type definition), so
-- an AI following an example does not write a definition the schema
-- refuses. Both examples are news types: collection:true.
--
-- Mechanics: replace() of exact passages; absent passage = no-op, so the
-- migration is idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(replace(
  body,
  $old$newPageType:{slug:"news", name:"News article", purpose:"…", properties:[…]$old$,
  $new$newPageType:{slug:"news", name:"News article", purpose:"…", collection:true, properties:[…]$new$),
  $old$upsert_page_types_many({pageTypes:[{slug:"news", name:"News article", purpose:"Dated company news; listed newest first on the news overview and in the header's latest-news panel", templates:$old$,
  $new$upsert_page_types_many({pageTypes:[{slug:"news", name:"News article", purpose:"Dated company news; listed newest first on the news overview and in the header's latest-news panel", collection:true, templates:$new$)
WHERE slug = 'manage-page-types';

COMMIT;
