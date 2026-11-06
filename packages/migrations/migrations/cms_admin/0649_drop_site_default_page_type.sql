-- SPDX-License-Identifier: MPL-2.0
-- caelo:contract drops site_defaults.default_page_type_id and default_template_id; an image older than #1276 (0444, first shipped in v0.11.6) reads and writes them
-- caelo:requires-earlier-run 0444_site_defaults_no_default_page_type.sql
--
-- 0649 — the contract half of #1276 (issue #1279).
--
-- There is no stored default page type or template: a page's type is always
-- chosen, a template always names its page type. 0444 made both columns
-- nullable and every image since v0.11.6 neither reads nor writes them, so
-- they are dead schema now. `default_layout_id` stays: a new template
-- without a layout still takes the stored default layout.
--
-- The requires-earlier-run header makes the runner refuse an install that
-- jumps from before 0444 straight here: its running image still reads the
-- columns while this migration would drop them under it. No CASCADE: the
-- only dependents are the columns' own foreign keys, which go with them;
-- anything else depending on a column is schema drift and must fail loudly.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_defaults DROP COLUMN default_template_id;
ALTER TABLE site_defaults DROP COLUMN default_page_type_id;

COMMIT;
