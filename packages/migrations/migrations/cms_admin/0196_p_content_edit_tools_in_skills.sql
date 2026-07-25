-- SPDX-License-Identifier: MPL-2.0
--
-- 0196 — teach the editing skills the Claude-Code-style read/edit/grep loop
-- over DB-stored bodies (read_content / edit_content / grep_content).
--
-- These tools let the AI change existing module/template html/css/js by
-- surgical string replacement (edit_content) instead of re-emitting the whole
-- body via edit_module — far cheaper on tokens and the diff is minimal
-- (CLAUDE.md §8). The system prompt's module block + module-model guidance
-- already cover them; a freshly-loaded skill body outweighs the always-on
-- playbook (see 0170's root-cause), so any skill that instructs the AI to
-- EDIT module code must repeat the loop, or the model retreats to a full-body
-- edit_module rewrite while the skill is engaged.
--
-- Scope generically: every skill whose allowlist carries `edit_module` is an
-- edit skill (design-quality, compose-page, scoped-edit, manage-module, …).
--
-- (1) Allowlist = preload hints post-Tool-Search. read_content + edit_content
--     are already core (always loaded), but listing them keeps the skill's
--     intent explicit; grep_content is deferred, so allowlisting it here
--     preloads it for catalog-wide "change X everywhere" edits. Idempotent via
--     the jsonb element-membership guard (mirrors 0194).
-- (2) Append the surgical-edit paragraph to the body. Idempotent via the
--     sentinel-phrase guard so a re-run appends nothing.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- (1) Preload the read/edit/grep tools wherever edit_module is allowlisted.
-- One idempotent UPDATE per tool (same shape as 0194's element-membership
-- guard) — simpler + safer than a correlated jsonb_agg subquery.
UPDATE skills SET allowlisted_tools = allowlisted_tools || '["read_content"]'::jsonb
 WHERE allowlisted_tools ? 'edit_module' AND NOT (allowlisted_tools ? 'read_content');

UPDATE skills SET allowlisted_tools = allowlisted_tools || '["edit_content"]'::jsonb
 WHERE allowlisted_tools ? 'edit_module' AND NOT (allowlisted_tools ? 'edit_content');

UPDATE skills SET allowlisted_tools = allowlisted_tools || '["grep_content"]'::jsonb
 WHERE allowlisted_tools ? 'edit_module' AND NOT (allowlisted_tools ? 'grep_content');

-- (2) Append the surgical-edit loop to every skill that EDITS module code —
-- whether it narrows via the allowlist (compose-page/manage-module/scoped-edit)
-- OR just references edit_module in its prose (design-quality's review loop,
-- site-genesis). The empty-allowlist skills deliberately keep their allowlist
-- empty (no narrowing) — read_content/edit_content are core (always loaded)
-- anyway; only the BODY guidance matters there. Idempotent via the sentinel.
UPDATE skills
   SET body = body || E'\n\nSURGICAL EDITS (read_content -> edit_content): to change EXISTING code in a module/template (a colour, a class, a string, a broken tag), do NOT re-emit the whole body via edit_module. First read the current body with read_content (line-numbered, windowable); then call edit_content with {entityKind, entityId, field, edits:[{oldString, newString, replaceAll?}]} — each oldString must be unique (add surrounding context) or pass replaceAll. It is far cheaper than a full-body rewrite and the diff is minimal. edit_content returns the new sha + a cat -n snippet of each change, so you can chain another edit_content in the SAME turn (reuse the sha as expectedSha) WITHOUT re-reading. Use grep_content to locate a string/regex across all modules + templates before editing. Reserve edit_module for a wholesale rewrite, a brand-new module body, or field-schema / displayName / kind changes. Template edit_content is Owner-gated (you propose; the Owner approves).'
 WHERE (allowlisted_tools ? 'edit_module' OR body LIKE '%edit_module%')
   AND position('SURGICAL EDITS (read_content -> edit_content)' in body) = 0;

COMMIT;
