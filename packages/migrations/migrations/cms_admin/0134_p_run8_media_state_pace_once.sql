-- SPDX-License-Identifier: MPL-2.0
--
-- 0134 — site-migrate: state-based media trigger + pace/mode asked ONCE
-- (migration run #8, 2026-07-13).
--
-- Two live-hits from run #8:
--
--   1. Media migration never ran. 0131 phrased the trigger as a compose
--      FOLLOW-UP ("immediately after `compose_from_import`, call
--      `migrate_media`") — but compose had already happened in an
--      earlier session, so the "after compose" moment never occurred in
--      the session doing the rebuild work and every page kept
--      hotlinking the source host. The trigger must be STATE-based:
--      check at the start of route A/B work AND before reporting done.
--
--   2. The orchestrator re-asked A/B pace questions after the operator
--      had already chosen a mode and said to proceed. The plan/scope
--      question is asked ONCE; afterwards the standing answer is
--      "proceed".
--
-- Guarded + idempotent like 0130/0131/0132: each UPDATE matches a
-- stable substring of the current body and no-ops once its marker text
-- is in place.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- (1) Replace 0131's compose-follow-up media sentence with the
-- state-based contract. The matched text is exactly what 0131 inserted;
-- the trailing 'Then ' keeps the sentence that follows intact whether
-- or not 0132's fan-out rewrite ran.
UPDATE skills
SET body = replace(
  body,
  'For A and B: immediately after `compose_from_import`, call `migrate_media` for the run — migrated pages must reference Caelo-hosted media, never hotlink the source host. Relay every skipped asset (url + reason) to the operator verbatim; never claim media migrated when the report says skipped. Then ',
  'For A and B, MEDIA IS A STATE CHECK, not a compose follow-up (compose may have run in an earlier session — a trigger phrased as "after compose" then never fires): at the START of route A/B work AND again BEFORE reporting the migration done, check whether the run''s pages still reference source-host media or `migrate_media` has not yet been run for this run — if either holds, call `migrate_media` NOW. NEVER report the migration done while any page hotlinks the source host. Relay every skipped asset (url + reason) to the operator verbatim; never claim media migrated when the report says skipped. Then '
)
WHERE slug = 'site-migrate'
  AND body LIKE '%immediately after `compose_from_import`, call `migrate_media`%'
  AND body NOT LIKE '%MEDIA IS A STATE CHECK%';

-- (2) Pace/mode is asked once — appended contract paragraph (0120 style).
UPDATE skills
SET body = body || '

PACE/MODE IS ASKED ONCE: the design fork (step 3) and the plan/scope check (step 4) are each asked exactly once per migration. Once the operator has chosen a route and told you to proceed, PROCEED — never re-ask which mode to use, whether to continue, or whether the pace is okay between clusters or batches; the standing answer is yes. Interrupt with a question ONLY on a NEW error condition (e.g. a subagent failed twice, the crawl went stale) or a genuine cost overrun beyond the scope the operator approved — and then ask about that specific problem, not the plan.'
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%PACE/MODE IS ASKED ONCE%';

COMMIT;
