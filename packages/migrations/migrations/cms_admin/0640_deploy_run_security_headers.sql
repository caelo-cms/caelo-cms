-- SPDX-License-Identifier: MPL-2.0
--
-- 0640 — the headers each build ships (#1454).
--
-- A CSP is derived from what one build contains, so it is recorded on that
-- build's run. Reads answer "what do staging and the live site send now"
-- from it: a promote or rollback run names its build in build_id. Null on a
-- run from before the headers existed.

ALTER TABLE deploy_runs ADD COLUMN IF NOT EXISTS security_headers jsonb;
