-- SPDX-License-Identifier: MPL-2.0
--
-- 0894 — #1752: the SEO head fields of CMS_REQUIREMENTS §11.
--
-- 1. `pages_seo` gains the page's own SEO title (separate from the page
--    title), Open Graph title and description overrides, the robots
--    directives besides `noindex` (one `<meta name="robots">`; the column
--    defaults are what a page without directives says, `max-image-preview`
--    `large` included), the placements whose content carries
--    `data-nosnippet` (content instance ids), and who wrote each own text
--    (`value_origins`: `human` | `ai` | `reviewed` per field, only for
--    non-empty texts). A row without values for them is exactly what a
--    page that has none reads as, like every other column of this table.
--
-- 2. Backfill of `value_origins` for the meta descriptions that exist:
--    nothing recorded who wrote them, so the rule is the AI when the page's
--    SEO was ever autofilled or optimized (both only ever ran for the AI),
--    else a person. `completeSeoOrigins` (packages/shared/src/seo-head.ts)
--    applies the same rule to a text written without an origin — an older
--    snapshot, or the previous release during an update — so every reader
--    agrees with this backfill.
--
-- 3. `site_defaults.seo_title_template`: the `<title>` of every page
--    without its own SEO title whose page type has no template of its own
--    (precedence site → page type → page). Stored data, never a read-time
--    default (CLAUDE.md §2); `{page_title}` is the title every page had
--    until now, so no page's title changes with this migration.
--
-- Page types keep their title template and og:type in their definition
-- (`PageTypeDef.seo`, optional), which needs no schema change.
--
-- Expand-only (#696): new columns with defaults; the previous image never
-- names them and keeps reading and writing every column it knows.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE pages_seo
  ADD COLUMN seo_title text NOT NULL DEFAULT ''
    CONSTRAINT pages_seo_seo_title_len CHECK (char_length(seo_title) <= 200),
  ADD COLUMN og_title text NOT NULL DEFAULT ''
    CONSTRAINT pages_seo_og_title_len CHECK (char_length(og_title) <= 200),
  ADD COLUMN og_description text NOT NULL DEFAULT ''
    CONSTRAINT pages_seo_og_description_len CHECK (char_length(og_description) <= 320),
  ADD COLUMN nofollow boolean NOT NULL DEFAULT false,
  ADD COLUMN noarchive boolean NOT NULL DEFAULT false,
  ADD COLUMN nosnippet boolean NOT NULL DEFAULT false,
  ADD COLUMN noimageindex boolean NOT NULL DEFAULT false,
  ADD COLUMN max_snippet integer NULL
    CONSTRAINT pages_seo_max_snippet_range CHECK (max_snippet IS NULL OR max_snippet BETWEEN -1 AND 100000),
  ADD COLUMN max_image_preview text NOT NULL DEFAULT 'large'
    CONSTRAINT pages_seo_max_image_preview_values CHECK (max_image_preview IN ('none', 'standard', 'large')),
  ADD COLUMN max_video_preview integer NULL
    CONSTRAINT pages_seo_max_video_preview_range CHECK (max_video_preview IS NULL OR max_video_preview BETWEEN -1 AND 86400),
  ADD COLUMN nosnippet_content jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT pages_seo_nosnippet_content_array CHECK (jsonb_typeof(nosnippet_content) = 'array'),
  ADD COLUMN value_origins jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT pages_seo_value_origins_object CHECK (jsonb_typeof(value_origins) = 'object');

UPDATE pages_seo
   SET value_origins = jsonb_build_object(
         'metaDescription',
         CASE WHEN autofilled_at IS NOT NULL OR optimized_at IS NOT NULL THEN 'ai' ELSE 'human' END
       )
 WHERE meta_description <> '';

ALTER TABLE site_defaults
  ADD COLUMN seo_title_template text NOT NULL DEFAULT '{page_title}'
    CONSTRAINT site_defaults_seo_title_template_shape CHECK (
      char_length(seo_title_template) BETWEEN 1 AND 200
      AND (seo_title_template LIKE '%{page_title}%' OR seo_title_template LIKE '%{short_title}%')
    );

COMMENT ON COLUMN site_defaults.seo_title_template IS
  '#1752 — <title> of pages without their own SEO title whose page type has no template: {page_title}, {short_title}, {site_name}.';
COMMENT ON COLUMN pages_seo.value_origins IS
  '#1752 — who wrote each non-empty own text (seoTitle, metaDescription, ogTitle, ogDescription): human | ai | reviewed.';
COMMENT ON COLUMN pages_seo.nosnippet_content IS
  '#1752 — content instance ids of the page placements rendered with data-nosnippet.';

COMMIT;
