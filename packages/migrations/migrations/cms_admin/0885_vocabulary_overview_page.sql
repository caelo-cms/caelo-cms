-- SPDX-License-Identifier: MPL-2.0
--
-- 0885 — every vocabulary entry can name its overview page (issue #1754,
-- epic #1751; docs/lists.md §3).
--
-- A term (a category, a tag, a topic) points to the page that is its
-- overview — a curated topic page, a category page: term chips link
-- there (`{{link}}` on a term entry) and a breadcrumbs source given the
-- vocabulary leads through it. Until now only the shipped `categories`
-- type had that field (`landing_page`, a link); `tags` and every
-- vocabulary type an operator or the AI created had no place for it.
-- From now on `checkListTypeDef` requires a link field `landing_page` on
-- every vocabulary entry kind, so every stored vocabulary type gets one
-- (no read-time default, CLAUDE.md §2): appended to the fields of each
-- top-level node kind that lacks a field of that name, labelled
-- "Overview page". A kind that already has a field named `landing_page`
-- of another type is left alone; its next edit names the problem.
--
-- The same rule runs over the live rows and every list-type snapshot (its
-- `definition`), so an undo, a revert or a chat's pending state never
-- reads a vocabulary type without the field. Idempotent: a definition
-- that has the field is not touched.
--
-- Expand-only (#696): a new optional field on stored definitions. The
-- previous image reads it as any other link field and accepts it on
-- write.

SET LOCAL caelo.actor_kind = 'system';

CREATE FUNCTION pg_temp.with_term_overview(def jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN def->>'role' IS DISTINCT FROM 'vocabulary'
      OR jsonb_typeof(def->'nodes') IS DISTINCT FROM 'object'
      OR jsonb_typeof(def->'root'->'allow') IS DISTINCT FROM 'array'
    THEN def
    ELSE jsonb_set(def, '{nodes}', (
      SELECT COALESCE(jsonb_object_agg(
               e.kind,
               CASE
                 WHEN (def->'root'->'allow') ? e.kind
                  AND jsonb_typeof(e.node->'fields') = 'array'
                  AND NOT EXISTS (
                        SELECT 1 FROM jsonb_array_elements(e.node->'fields') f
                        WHERE f->>'name' = 'landing_page'
                      )
                 THEN jsonb_set(
                        e.node,
                        '{fields}',
                        (e.node->'fields')
                          || '[{"name": "landing_page", "label": "Overview page", "type": "link"}]'::jsonb
                      )
                 ELSE e.node
               END
             ), '{}'::jsonb)
        FROM jsonb_each(def->'nodes') AS e(kind, node)
    ))
  END
$$;

--> statement-breakpoint

UPDATE list_types
   SET definition = pg_temp.with_term_overview(definition)
 WHERE definition->>'role' = 'vocabulary'
   AND definition IS DISTINCT FROM pg_temp.with_term_overview(definition);

--> statement-breakpoint

UPDATE list_type_snapshots
   SET state = jsonb_set(state, '{definition}', pg_temp.with_term_overview(state->'definition'))
 WHERE jsonb_typeof(state->'definition') = 'object'
   AND state->'definition'->>'role' = 'vocabulary'
   AND state->'definition' IS DISTINCT FROM pg_temp.with_term_overview(state->'definition');
