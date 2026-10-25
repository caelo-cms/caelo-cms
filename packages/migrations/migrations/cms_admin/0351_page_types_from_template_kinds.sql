-- SPDX-License-Identifier: MPL-2.0
--
-- caelo:contract templates.kind is dropped; the previous image reads and writes it
--
-- 0351 — epic #1107 part B: page types replace `templates.kind`
-- (docs/lists.md §5). One-way data migration, no fallback paths
-- (CLAUDE.md §2):
--
--   1. One page type per template kind in use, slug = the kind, with a
--      plain name and purpose. Its `templates` are the non-deleted
--      templates of that kind (all templates of the kind when every one is
--      deleted, so pages bound to them still have a type); its
--      `defaultTemplate` is the template most live pages use (oldest on a
--      tie).
--   2. `pages.page_type_id` (NOT NULL) = the type of the page's template;
--      `pages.properties` (validated against the type by the ops);
--      `pages.first_published_at`, set by the first Publish live — backfilled
--      from the first successful production build after the page was
--      created, for pages that are published now.
--   3. Page snapshots gain the three fields (pageTypeId from the snapshot's
--      template, empty properties and terms), so a revert or merge of an
--      older snapshot restores a typed page. A snapshot whose template no
--      longer exists keeps its shape and is refused loudly on revert.
--   4. `site_defaults.default_page_type_id` = the type of the default
--      template — the stored default for new pages.
--   5. Write-time derivation for out-of-op INSERTs (test seeds, import
--      tooling), the same precedent as 0211's current_path trigger: an
--      INSERT without page_type_id gets the one page type that lists its
--      template; none or several is a loud error naming the template.
--   6. `templates.kind` (and its CHECK) is dropped.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TEMP TABLE _kind_names (kind text PRIMARY KEY, name text NOT NULL, purpose text NOT NULL)
  ON COMMIT DROP;
INSERT INTO _kind_names (kind, name, purpose) VALUES
  ('home', 'Home page', 'The front page of the site: the first impression and the way into every section.'),
  ('landing', 'Landing page', 'A focused campaign or conversion page with one goal.'),
  ('product', 'Product page', 'One product or service: what it is, what it costs and how to get it.'),
  ('blog', 'Blog post', 'An article in the blog or news section: dated, and assignable to categories and tags.'),
  ('doc', 'Documentation page', 'A page of documentation or a help article.'),
  ('content', 'Content page', 'A general content page: about, team, contact, legal.'),
  ('utility', 'Utility page', 'A functional page such as search results, a not-found page or a thank-you page.');

DO $$
DECLARE
  k record;
  tpl_ids uuid[];
  default_tpl uuid;
BEGIN
  FOR k IN SELECT DISTINCT t.kind FROM templates t ORDER BY t.kind LOOP
    SELECT array_agg(id ORDER BY created_at, id) INTO tpl_ids
      FROM templates WHERE kind = k.kind AND deleted_at IS NULL;
    IF tpl_ids IS NULL THEN
      SELECT array_agg(id ORDER BY created_at, id) INTO tpl_ids
        FROM templates WHERE kind = k.kind;
    END IF;
    SELECT t.id INTO default_tpl
      FROM templates t
      LEFT JOIN pages p ON p.template_id = t.id AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
     WHERE t.id = ANY (tpl_ids)
     GROUP BY t.id, t.created_at
     ORDER BY count(p.id) DESC, t.created_at, t.id
     LIMIT 1;
    INSERT INTO page_types (slug, definition)
    SELECT k.kind, jsonb_build_object(
      'slug', k.kind,
      'name', n.name,
      'purpose', n.purpose,
      'templates', to_jsonb((SELECT array_agg(x::text) FROM unnest(tpl_ids) AS x)),
      'defaultTemplate', default_tpl::text,
      'properties', '[]'::jsonb,
      'vocabularies', '[]'::jsonb
    )
    FROM _kind_names n WHERE n.kind = k.kind;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'migration 0351: templates.kind % has no page-type name; add it to _kind_names', k.kind;
    END IF;
  END LOOP;
END $$;

ALTER TABLE pages
  ADD COLUMN page_type_id uuid REFERENCES page_types(id),
  ADD COLUMN properties jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(properties) = 'object'),
  ADD COLUMN first_published_at timestamptz;

UPDATE pages p
   SET page_type_id = pt.id
  FROM templates t
  JOIN page_types pt ON pt.slug = t.kind AND pt.chat_branch_id IS NULL
 WHERE t.id = p.template_id;

ALTER TABLE pages ALTER COLUMN page_type_id SET NOT NULL;
CREATE INDEX pages_page_type_idx ON pages (page_type_id) WHERE deleted_at IS NULL;

UPDATE pages p
   SET first_published_at = (
     SELECT min(r.finished_at)
       FROM deploy_runs r
       JOIN deploy_targets dt ON dt.id = r.target_id
      WHERE dt.env = 'production' AND r.status = 'succeeded' AND r.finished_at >= p.created_at
   )
 WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL;

UPDATE page_snapshots ps
   SET state = ps.state || jsonb_build_object(
     'pageTypeId', pt.id::text,
     'properties', '{}'::jsonb,
     'terms', '[]'::jsonb
   )
  FROM templates t
  JOIN page_types pt ON pt.slug = t.kind AND pt.chat_branch_id IS NULL
 WHERE ps.state ? 'templateId'
   AND t.id::text = ps.state->>'templateId';

ALTER TABLE site_defaults ADD COLUMN default_page_type_id uuid REFERENCES page_types(id);
UPDATE site_defaults sd
   SET default_page_type_id = pt.id
  FROM templates t
  JOIN page_types pt ON pt.slug = t.kind AND pt.chat_branch_id IS NULL
 WHERE t.id = sd.default_template_id;
ALTER TABLE site_defaults ALTER COLUMN default_page_type_id SET NOT NULL;

-- Write-time derivation (NOT a read-time fallback), see the header.
CREATE OR REPLACE FUNCTION pages_default_page_type() RETURNS trigger AS $$
DECLARE
  matches uuid[];
BEGIN
  IF NEW.page_type_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(pt.id) INTO matches
    FROM page_types pt
   WHERE pt.deleted_at IS NULL
     AND (pt.chat_branch_id IS NULL OR pt.chat_branch_id = NEW.chat_branch_id)
     AND pt.definition->'templates' ? NEW.template_id::text;
  IF matches IS NULL THEN
    RAISE EXCEPTION 'pages: template % belongs to no page type — add it to a page type''s templates (page_types.upsert_many) or pass page_type_id', NEW.template_id;
  END IF;
  IF array_length(matches, 1) > 1 THEN
    RAISE EXCEPTION 'pages: template % belongs to % page types — pass page_type_id to say which one this page is', NEW.template_id, array_length(matches, 1);
  END IF;
  NEW.page_type_id := matches[1];
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_page_type_default ON pages;
CREATE TRIGGER pages_page_type_default
  BEFORE INSERT ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_default_page_type();

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_kind_check;
ALTER TABLE templates DROP COLUMN kind;

COMMIT;
