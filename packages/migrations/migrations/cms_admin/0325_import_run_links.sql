-- SPDX-License-Identifier: MPL-2.0
--
-- 0325 — epic #724, rollout C: internal links to pages an import run will
-- still build (maintainer decision on open point 1 of #873: option b).
--
-- Rollout C stores internal links as page references and refuses a link
-- to a page that does not exist. In the migrate flow the AI rebuilds a
-- crawled site page by page, so while the rebuilding chat's import run
-- is active a link to one of the run's planned pages is kept as written
-- and recorded here, against the content that holds it, instead of
-- refused. `imports.resolve_links` (the skill's closing step; the run's
-- cleanup runs it too) rewrites that content once the pages exist: the
-- link becomes a reference, or — when it still matches no page — an
-- `unresolved` finding in the run report. compose_from_run's links that
-- match no imported page land here as findings too.
--
-- The site-migrate skill learns the closing call. Same guard pattern as
-- 0272: `replace()` only where the exact old text is present and the new
-- tool name is not, so it is idempotent, a no-op on an install whose
-- text has moved on, and never touches an Owner-edited body.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS import_run_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  -- The link exactly as written.
  value       text NOT NULL,
  -- 'pending': written while its page did not exist yet;
  -- 'resolved': stored as a page reference by the run's finalisation;
  -- 'unresolved': still matches no page (finalisation or compose).
  status      text NOT NULL CHECK (status IN ('pending', 'resolved', 'unresolved')),
  -- The content holding it, which the finalisation rewrites.
  entity_kind text NOT NULL CHECK (entity_kind IN ('content_instance', 'module', 'structured_set')),
  entity_id   uuid NOT NULL,
  -- Where inside it: `values.cta_href`, `html`, `items[0].href`, …
  location    text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, value, entity_kind, entity_id)
);

CREATE INDEX IF NOT EXISTS import_run_links_run_status_idx
  ON import_run_links (run_id, status);

-- Same scope as the import tables: any authenticated actor session; who
-- may finalise is decided at the op.
ALTER TABLE import_run_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_run_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_run_links_authenticated_scope ON import_run_links;
CREATE POLICY import_run_links_authenticated_scope ON import_run_links
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

UPDATE skills
   SET body = replace(
     body,
     'it resolves the moment the page is built, and the stage/publish link-integrity check flags any that stay dead.',
     'a link to a page of this import run that you have not built yet is kept exactly as you wrote it and recorded against the run (it is not refused); `resolve_import_links` turns it into a page reference once the page exists, and lists any link that still matches no page. A link to a path that is neither an existing page nor a page of the run is refused: fix the path.'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%it resolves the moment the page is built, and the stage/publish link-integrity check flags any that stay dead.%'
   AND body NOT LIKE '%resolve_import_links%';

UPDATE skills
   SET body = replace(
     body,
     ', and CLOSE with `get_import_run_report` in plain words:',
     ', call `resolve_import_links({runId})` once every page is built (it converts the links you wrote before their pages existed and names any that match no page — fix those links or build the page, then call it again), and CLOSE with `get_import_run_report` in plain words, including any unresolved internal links it lists:'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%, and CLOSE with `get_import_run_report` in plain words:%'
   AND body NOT LIKE '%resolve_import_links({runId})%';

COMMIT;
