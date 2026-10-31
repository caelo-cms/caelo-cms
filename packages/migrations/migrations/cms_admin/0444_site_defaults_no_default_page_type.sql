-- SPDX-License-Identifier: MPL-2.0
--
-- 0444 — #1276: no stored default page type or template.
--
-- A page's type is now always chosen (pageType, or a template that belongs
-- to exactly one page type), and a template always names its page type
-- (pageType or newPageType). Nothing reads
-- `site_defaults.default_page_type_id` or `default_template_id` any more,
-- and `site_defaults.set` stops writing them.
--
-- Expand half of a two-release drop (RELEASING.md "Contract migrations"):
-- the columns stay so the previous image, which still reads and writes
-- them, keeps running on this schema; they only lose NOT NULL, because
-- this image creates the singleton row without them. The next release
-- drops both columns with `-- caelo:requires-earlier-run
-- 0444_site_defaults_no_default_page_type.sql`. `default_layout_id` stays:
-- a new template without a layout still takes the stored default layout
-- (CLAUDE.md §11.A first-run argument).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_defaults ALTER COLUMN default_template_id DROP NOT NULL;
ALTER TABLE site_defaults ALTER COLUMN default_page_type_id DROP NOT NULL;

COMMIT;
