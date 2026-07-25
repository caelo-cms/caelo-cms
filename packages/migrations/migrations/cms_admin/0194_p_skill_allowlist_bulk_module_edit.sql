-- SPDX-License-Identifier: MPL-2.0
--
-- 0194 — every skill that allowlists `edit_module` must also allowlist its
-- BULK pair `update_modules_many`.
--
-- A skill's `allowlisted_tools` NARROWS the AI's write-tool catalogue to that
-- list (load-skill.ts / propose-skill.ts). `scoped-edit` (["edit_module"]),
-- `compose-page`, and `manage-module` allowlisted the singular `edit_module`
-- but NOT `update_modules_many`, so whenever one of those skills was engaged
-- the bulk tool was FILTERED OUT of the catalogue — the AI physically could
-- not batch a multi-module edit and fell back to N sequential `edit_module`
-- calls (a wall of tool-call/result events, exactly what §11 bulk variants
-- exist to prevent). `edit_module`'s own description already says "Prefer
-- update_modules_many when targeting > 1 module"; the allowlist made that
-- impossible.
--
-- Fix generically: append `update_modules_many` to ANY active skill that
-- carries `edit_module` but lacks the bulk variant. Idempotent via the jsonb
-- element-membership guard.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET allowlisted_tools = allowlisted_tools || '["update_modules_many"]'::jsonb
 WHERE allowlisted_tools ? 'edit_module'
   AND NOT (allowlisted_tools ? 'update_modules_many');

COMMIT;
