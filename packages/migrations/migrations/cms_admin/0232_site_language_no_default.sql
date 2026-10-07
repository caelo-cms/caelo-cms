-- SPDX-License-Identifier: MPL-2.0
-- site_defaults.site_language (0230) shipped as NOT NULL DEFAULT 'en', so
-- every install silently became English without anyone choosing it: a
-- stored fallback, the same trap #551 removed from site_base_url (0229).
--
-- The column now has no default and NULL means "not configured". A row
-- still holding 'en' carries the default unless someone chose English: the
-- only writer since 0230, `site_defaults.set_identity` (AI tool and the
-- /security/seo form alike), audits every language write with a result
-- summary ending in `siteLanguage=<tag>`. A row holding 'en' with such an
-- audited 'en' write keeps it; every other 'en' was never chosen and
-- becomes NULL.
--
-- Who sets it: the AI through `set_site_identity({siteLanguage})` (op
-- `site_defaults.set_identity`, AI-writable), inferred from the language
-- the operator writes in or the migrated site's `<html lang>`; the cold-
-- start status line names that tool while the value is NULL. The Owner can
-- also set it under Security -> SEO. The static generator refuses to build
-- without it and the preview flags `site-language-unset` (CLAUDE.md §2: no
-- fallbacks pre-1.0). The CHECK from 0230 still applies to set values.
ALTER TABLE site_defaults ALTER COLUMN site_language DROP DEFAULT;
ALTER TABLE site_defaults ALTER COLUMN site_language DROP NOT NULL;
UPDATE site_defaults SET site_language = NULL
 WHERE site_language = 'en'
   AND NOT EXISTS (
     SELECT 1 FROM audit_events
      WHERE operation = 'site_defaults.set_identity'
        AND succeeded
        AND result_summary LIKE '% siteLanguage=en'
   );

COMMENT ON COLUMN site_defaults.site_language IS
  'BCP 47 document language rendered as <html lang> on every page a plugin does not assign its own locale to. NULL = not configured; the static build refuses to run until it is set.';
