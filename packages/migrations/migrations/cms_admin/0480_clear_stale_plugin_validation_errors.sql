-- SPDX-License-Identifier: MPL-2.0
--
-- 0480 — clear validator findings left on release-signed plugins (#1306).
--
-- `plugins.validation_errors` describes a runtime-authored submission. The
-- loader before #1008 also wrote load failures of release-signed plugins
-- there (a `CREATE SCHEMA` race of 2026-10-22, fixed in #1014, among them),
-- and nothing ever cleared them: 0344 only reset the rows it moved out of
-- `failed`. `get_plugin` printed those findings as current, so the AI
-- diagnosed a problem that was long gone. Load problems live in
-- `plugin_errors` since #1008, and the loader's upsert now clears these
-- findings on every load; this removes the leftovers on rows that run.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE plugins
SET validation_errors = '[]'::jsonb
WHERE tier = 1
  AND status = 'active'
  AND validation_errors <> '[]'::jsonb;

COMMIT;
