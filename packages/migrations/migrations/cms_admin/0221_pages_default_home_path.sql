-- SPDX-License-Identifier: MPL-2.0
-- The write-time default for pages.current_path (0211) gave every
-- out-of-op INSERT "/<slug>" — including the home slugs. A page seeded
-- or imported as `home` therefore sat at "/home" until some write op
-- happened to recompose it, and a build whose home page was never
-- touched again had no page at "/" (the generator's root check fails).
--
-- The default now applies the core composition's home rule
-- (current-path.ts isCompositionHome): without a designated home page,
-- the home slugs '', 'home' and 'index' compose to "/". With a
-- designation, only the designated page is the root, and these slugs
-- stay "/<slug>". URL-plugin annotations still need a write op; this is
-- core's own rule only.
CREATE OR REPLACE FUNCTION pages_default_current_path() RETURNS trigger AS $$
BEGIN
  IF NEW.current_path IS NULL THEN
    IF btrim(NEW.slug, '/') IN ('', 'home', 'index')
       AND NOT EXISTS (
         SELECT 1 FROM site_defaults WHERE id = 1 AND home_page_id IS NOT NULL
       ) THEN
      NEW.current_path := '/';
    ELSE
      NEW.current_path := '/' || NEW.slug;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
