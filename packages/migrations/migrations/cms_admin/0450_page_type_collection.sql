-- SPDX-License-Identifier: MPL-2.0
--
-- 0450 — every page type says whether it is a collection (maintainer
-- decision on #1256 / #1276, 2026-10-30).
--
-- `structure/manual-page-listing` flags hand-kept cards that list pages of
-- one type. That is right for a COLLECTION — many similar pages meant to
-- be listed or queried (blog, news, products, jobs, docs) — and wrong for
-- standalone pages: a footer linking About, Team and Contact (three
-- `content` pages) is navigation, not a stale listing. So a page type's
-- definition gains a required `collection` boolean; the check looks only
-- at collection types.
--
-- Backfill (no read-time default, CLAUDE.md §2 — the field is required in
-- the schema from now on, so every stored definition gets one):
--   collection = true   for the 0351 kinds blog, doc and product, and for
--                       any type with vocabularies or a `date` property
--                       (dated or categorised pages are a set);
--   collection = false  otherwise (home, landing, content, utility, …).
-- The same rule runs over the live rows and every page_type snapshot
-- (its `definition`), so an undo or a branch overlay never reads a
-- definition without the flag. Idempotent: only definitions without the
-- key are touched.

SET LOCAL caelo.actor_kind = 'system';

CREATE FUNCTION pg_temp.page_type_is_collection(def jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (def->>'slug') IN ('blog', 'doc', 'product')
      OR jsonb_array_length(COALESCE(def->'vocabularies', '[]'::jsonb)) > 0
      OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(def->'properties', '[]'::jsonb)) p
           WHERE p->>'type' = 'date'
         )
$$;

--> statement-breakpoint

UPDATE page_types
   SET definition = definition
       || jsonb_build_object('collection', pg_temp.page_type_is_collection(definition))
 WHERE NOT (definition ? 'collection');

--> statement-breakpoint

UPDATE page_type_snapshots
   SET state = jsonb_set(
         state,
         '{definition,collection}',
         to_jsonb(pg_temp.page_type_is_collection(state->'definition'))
       )
 WHERE jsonb_typeof(state->'definition') = 'object'
   AND NOT (state->'definition' ? 'collection');
