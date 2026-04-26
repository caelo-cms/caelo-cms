-- SPDX-License-Identifier: MPL-2.0
--
-- 0013 seeded out_dir as `dist/<env>` which collides with the per-package
-- tsc build output (also `dist/`). Move the deploy output to `output/<env>`
-- so static-gen runs cannot wipe a fresh build artifact.

UPDATE deploy_targets SET out_dir = 'output/dev'        WHERE name = 'dev';
UPDATE deploy_targets SET out_dir = 'output/staging'    WHERE name = 'staging';
UPDATE deploy_targets SET out_dir = 'output/production' WHERE name = 'production';
