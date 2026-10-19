-- SPDX-License-Identifier: MPL-2.0
--
-- 0294 — epic #724 rollout E: the site-migrate skill learns how internal
-- links to not-yet-built pages work.
--
-- Rollout C stores internal links as page references and refuses a link
-- to a page that does not exist. During an import the AI builds page by
-- page, so a link to a page of the run that is not built yet is now kept
-- as written and recorded against the run; `resolve_import_links` turns
-- those into references once every page exists, and the run report lists
-- what still matches no page. The skill already told the AI to link to
-- the intended slug before the page exists; these two guarded
-- replacements say what happens to such links and add the closing call.
--
-- Same guard pattern as 0272: `replace()` only where the exact old text is
-- present and the new tool name is not, so it is idempotent, a no-op on an
-- install whose text has moved on, and never touches an Owner-edited body.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'it resolves the moment the page is built, and the stage/publish link-integrity check flags any that stay dead.',
     'it is kept exactly as you wrote it and recorded against the import run (the link check does not refuse a link to a page of this run that you have not built yet); `resolve_import_links` turns it into a page reference once the page exists, and the stage/publish link-integrity check flags any that stay dead.'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%it resolves the moment the page is built, and the stage/publish link-integrity check flags any that stay dead.%'
   AND body NOT LIKE '%resolve_import_links%';

UPDATE skills
   SET body = replace(
     body,
     ', and CLOSE with `get_import_run_report` in plain words:',
     ', call `resolve_import_links({runId})` once every page is built (it converts the links you wrote before their pages existed and names any that match no page — fix those or build the page, then call it again), and CLOSE with `get_import_run_report` in plain words, including any unresolved internal links it lists:'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%, and CLOSE with `get_import_run_report` in plain words:%'
   AND body NOT LIKE '%resolve_import_links({runId})%';

COMMIT;
