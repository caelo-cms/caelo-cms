-- SPDX-License-Identifier: MPL-2.0
--
-- 0131 — site-migrate: the media-migration step (issue #249, WS3).
-- The migrate_media op/tool (PR #258) downloads every asset the
-- composed pages reference into the Caelo media library and rewrites
-- the URLs; without this step the "migrated" site keeps hotlinking
-- the source host and dies with it. The skill must call it right
-- after compose and relay skips verbatim (CLAUDE.md §2 loud honesty).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  'For A and B the working unit is the CLUSTER:',
  'For A and B: immediately after `compose_from_import`, call `migrate_media` for the run — migrated pages must reference Caelo-hosted media, never hotlink the source host. Relay every skipped asset (url + reason) to the operator verbatim; never claim media migrated when the report says skipped. Then the working unit is the CLUSTER:'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%For A and B the working unit is the CLUSTER:%'
  AND body NOT LIKE '%migrate_media%';

COMMIT;
