-- SPDX-License-Identifier: MPL-2.0
--
-- 0358 — #1142 breadcrumbs.
--
-- 1. `pages.short_title`: the page's public label in breadcrumbs and
--    navigation ("Pricing" for "Pricing for teams of every size"),
--    translated with the page. Backfilled from `title` — the value a
--    page had as its crumb label until now — and stored, never derived
--    at read time (CLAUDE.md §2). Pending and historic page snapshots
--    get the same value, so a merge or revert of an older snapshot
--    replays a complete state. It replaces the internal `pages.name`.
-- 2. The `site-texts` list type and one "Site texts" list: fixed
--    interface strings (the breadcrumb aria-label, "Read more") that
--    module HTML reads with `{{site_text.<key>}}`, translatable like any
--    shared list. The JSON between the markers is exactly
--    `SITE_TEXTS_TYPE` (packages/shared/src/lists/default-types.ts);
--    packages/migrations/src/site-texts-seed.test.ts fails when the two
--    drift. The list starts empty: the AI adds a key the first time a
--    module reads it, in the site's language.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE pages ADD COLUMN short_title text;
UPDATE pages SET short_title = title;
ALTER TABLE pages
  ALTER COLUMN short_title SET NOT NULL,
  ADD CONSTRAINT pages_short_title_not_blank CHECK (btrim(short_title) <> '');

-- The ops always write short_title (pages.create resolves an omitted one
-- to the title at create time). This keeps out-of-op INSERTs (test
-- seeds, import tooling) valid under NOT NULL, like the current_path
-- default of 0211.
CREATE OR REPLACE FUNCTION pages_default_short_title() RETURNS trigger AS $$
BEGIN
  IF NEW.short_title IS NULL THEN
    NEW.short_title := NEW.title;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_short_title_default ON pages;
CREATE TRIGGER pages_short_title_default
  BEFORE INSERT ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_default_short_title();

-- `pages.name` (0020) was an internal editor label that never reached
-- the site and was lost on chat-branch edits (never in a snapshot). The
-- short title replaces it as the one label the page picker, breadcrumbs
-- and navigation show.
ALTER TABLE pages DROP COLUMN name;

UPDATE page_snapshots
   SET state = state || jsonb_build_object('shortTitle', state->'title')
 WHERE state ? 'title' AND NOT state ? 'shortTitle';

INSERT INTO list_types (slug, definition)
SELECT t->>'slug', t
  FROM (SELECT
-- caelo:seed-json-begin
$seed$
{
  "slug": "site-texts",
  "name": "Site texts",
  "purpose": "Fixed interface texts of the website, read by key in module HTML with {{site_text.<key>}}: the breadcrumb aria-label, button and link texts that repeat across modules. Not page content.",
  "role": "content",
  "root": {
    "allow": [
      "text"
    ]
  },
  "nodes": {
    "text": {
      "label": "Site text",
      "fields": [
        {
          "name": "key",
          "label": "Key",
          "type": "text",
          "required": true,
          "maxLength": 64
        },
        {
          "name": "text",
          "label": "Text",
          "type": "text",
          "required": true
        }
      ]
    }
  }
}
$seed$
-- caelo:seed-json-end
  ::jsonb AS t) s
 WHERE NOT EXISTS (
   SELECT 1 FROM list_types lt
    WHERE lt.slug = t->>'slug' AND lt.chat_branch_id IS NULL AND lt.deleted_at IS NULL
 );

INSERT INTO lists (slug, name, purpose, list_type_id)
SELECT 'site-texts', 'Site texts',
       'The fixed interface texts of the website (breadcrumb aria-label, repeated button and link texts), read by key in module HTML with {{site_text.<key>}}.',
       lt.id
  FROM list_types lt
 WHERE lt.slug = 'site-texts' AND lt.chat_branch_id IS NULL AND lt.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM lists l
      WHERE l.slug = 'site-texts' AND l.chat_branch_id IS NULL AND l.deleted_at IS NULL
   );

COMMIT;
