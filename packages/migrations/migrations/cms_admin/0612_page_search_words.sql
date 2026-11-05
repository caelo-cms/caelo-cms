-- SPDX-License-Identifier: MPL-2.0
--
-- 0612 — the words of every page, for a page search that reads what it
-- finds (issue #1269, epic #1392).
--
-- The editor's page search, its link-target suggestions and the AI's page
-- lookups loaded every page of the site and filtered in the process: on a
-- 50,000-page site that is a 15 s read on every editor load (the capped
-- scale gate). A substring search cannot use an index under FORCEd row
-- level security (LIKE, ILIKE and the trigram operators are not
-- leakproof), but a word-prefix search can: `starts_with` (`^@`) and text
-- comparisons are leakproof, and over a "C"-collated btree `^@` is a range
-- of the index.
--
-- Two tables of synchronous derived state (rule 3 of
-- docs/dev/state-and-changes.md), maintained by statement-level triggers
-- in the writer's own transaction:
--
--   page_search_words          one row per (word, page) of every page
--                              row: the words of its title, short title
--                              and slug.
--   draft_pending_page_words   one row per (branch, word, head row) of the
--                              draft head (0477): the same words of each
--                              pending page state, so a branch's search
--                              reads only its own pending pages, never
--                              the snapshot history of the site.
--
-- A word is a maximal run of letters and digits, lower-cased, cut at 64
-- characters (`caelo_search_words`); the search splits its query with the
-- same function, so both sides agree on what a word is.
--
-- Rebuild: `caelo_page_search_words_rebuild()` (the system op
-- pages.rebuild_search_words); the test preload checks maintained ==
-- rebuilt after every integration file. Backfilled below.
--
-- Expand-only: new tables, functions and triggers. The previous image
-- never reads them; its page and draft-head writes fire the triggers.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

/** The search words of `parts`: lower-cased runs of letters and digits, at most 64 characters. */
CREATE FUNCTION caelo_search_words(VARIADIC parts text[]) RETURNS SETOF text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT DISTINCT left(w, 64)
    FROM unnest(parts) p
   CROSS JOIN LATERAL regexp_split_to_table(lower(p), '[^[:alnum:]]+') w
   WHERE p IS NOT NULL AND w <> ''
$fn$;

CREATE TABLE page_search_words (
  word    text COLLATE "C" NOT NULL,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (word, page_id)
);
-- The FK, and the re-index of one page.
CREATE INDEX page_search_words_page_idx ON page_search_words (page_id);

CREATE TABLE draft_pending_page_words (
  chat_branch_id  uuid NOT NULL,
  snapshot_row_id uuid NOT NULL REFERENCES page_snapshots(id) ON DELETE CASCADE,
  word            text COLLATE "C" NOT NULL,
  page_id         uuid NOT NULL,
  PRIMARY KEY (chat_branch_id, snapshot_row_id, word)
);
-- The search: a branch's pending pages by word, in word order.
CREATE INDEX draft_pending_page_words_word_idx ON draft_pending_page_words
  (chat_branch_id, word, page_id);
-- The FK.
CREATE INDEX draft_pending_page_words_row_idx ON draft_pending_page_words (snapshot_row_id);

-- Same scope as the snapshot reference tables (0592, 0594): words of
-- titles and slugs, read by any authenticated session; the search confirms
-- every candidate through pages.list, which applies the caller's view.
ALTER TABLE page_search_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_search_words FORCE ROW LEVEL SECURITY;
CREATE POLICY page_search_words_authenticated_scope ON page_search_words
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
-- Maintained by the draft head's own triggers, whatever actor writes a
-- snapshot (the reason 0477 admits every writer): a policy that filtered
-- such a write would leave the words stale.
ALTER TABLE draft_pending_page_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_pending_page_words FORCE ROW LEVEL SECURITY;
CREATE POLICY draft_pending_page_words_read ON draft_pending_page_words FOR SELECT
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
CREATE POLICY draft_pending_page_words_insert ON draft_pending_page_words FOR INSERT
  WITH CHECK (true);
CREATE POLICY draft_pending_page_words_delete ON draft_pending_page_words FOR DELETE
  USING (true);

/** Trigger: index the words of inserted pages. */
CREATE FUNCTION caelo_page_search_words_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO page_search_words (word, page_id)
  SELECT w, n.id FROM new_rows n CROSS JOIN LATERAL caelo_search_words(n.title, n.short_title, n.slug) w
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-index pages whose title, short title or slug changed. */
CREATE FUNCTION caelo_page_search_words_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM page_search_words s
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE s.page_id = n.id
     AND (n.title, n.short_title, n.slug) IS DISTINCT FROM (o.title, o.short_title, o.slug);
  INSERT INTO page_search_words (word, page_id)
  SELECT w, n.id
    FROM new_rows n JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_search_words(n.title, n.short_title, n.slug) w
   WHERE (n.title, n.short_title, n.slug) IS DISTINCT FROM (o.title, o.short_title, o.slug)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_page_search_words_insert
  AFTER INSERT ON pages
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_page_search_words_on_insert();
CREATE TRIGGER caelo_page_search_words_update
  AFTER UPDATE ON pages
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_page_search_words_on_update();
-- A deleted page's words go with it (ON DELETE CASCADE); a truncate of
-- pages truncates the words through the FK (TRUNCATE ... CASCADE) or fails.

/** The words of the pending page states `p_rows` (head rows of the draft) points at. */
CREATE FUNCTION caelo_draft_page_words_insert(p_branches uuid[], p_rows uuid[]) RETURNS void
LANGUAGE sql
AS $fn$
  INSERT INTO draft_pending_page_words (chat_branch_id, snapshot_row_id, word, page_id)
  SELECT k.b, s.id, w, s.page_id
    FROM unnest(p_branches, p_rows) AS k(b, r)
    JOIN page_snapshots s ON s.id = k.r
   CROSS JOIN LATERAL caelo_search_words(
     s.state->>'title', s.state->>'shortTitle', s.state->>'slug') w
  ON CONFLICT DO NOTHING
$fn$;

/** Trigger: words for inserted page head rows. */
CREATE FUNCTION caelo_draft_page_words_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM caelo_draft_page_words_insert(
    ARRAY(SELECT n.chat_branch_id FROM new_rows n
           WHERE n.entity_kind = 'page' AND n.snapshot_row_id IS NOT NULL ORDER BY n.snapshot_row_id),
    ARRAY(SELECT n.snapshot_row_id FROM new_rows n
           WHERE n.entity_kind = 'page' AND n.snapshot_row_id IS NOT NULL ORDER BY n.snapshot_row_id));
  RETURN NULL;
END
$fn$;

/**
 * Trigger: a head row that now points at another snapshot row (a newer
 * pending state, a takeover to another branch) drops the old row's words
 * and gets the new one's.
 */
CREATE FUNCTION caelo_draft_page_words_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM draft_pending_page_words w
   USING old_rows o
   WHERE o.entity_kind = 'page' AND o.snapshot_row_id IS NOT NULL
     AND w.chat_branch_id = o.chat_branch_id AND w.snapshot_row_id = o.snapshot_row_id
     -- A head row of the branch still pointing at the row (this one
     -- unchanged in that respect, or another owner's) keeps its words.
     AND NOT EXISTS (
       SELECT 1 FROM draft_pending_entities d
        WHERE d.entity_kind = 'page' AND d.chat_branch_id = o.chat_branch_id
          AND d.snapshot_row_id = o.snapshot_row_id);
  PERFORM caelo_draft_page_words_insert(
    ARRAY(SELECT n.chat_branch_id FROM new_rows n
           WHERE n.entity_kind = 'page' AND n.snapshot_row_id IS NOT NULL ORDER BY n.snapshot_row_id),
    ARRAY(SELECT n.snapshot_row_id FROM new_rows n
           WHERE n.entity_kind = 'page' AND n.snapshot_row_id IS NOT NULL ORDER BY n.snapshot_row_id));
  RETURN NULL;
END
$fn$;

/** Trigger: deleted page head rows drop their words. */
CREATE FUNCTION caelo_draft_page_words_on_delete() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM draft_pending_page_words w
   USING old_rows o
   WHERE o.entity_kind = 'page' AND o.snapshot_row_id IS NOT NULL
     AND w.chat_branch_id = o.chat_branch_id AND w.snapshot_row_id = o.snapshot_row_id
     AND NOT EXISTS (
       SELECT 1 FROM draft_pending_entities d
        WHERE d.entity_kind = 'page' AND d.chat_branch_id = o.chat_branch_id
          AND d.snapshot_row_id = o.snapshot_row_id);
  RETURN NULL;
END
$fn$;

/** Trigger: a truncate of the draft head truncates its words. */
CREATE FUNCTION caelo_draft_page_words_on_truncate() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM draft_pending_page_words;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_draft_page_words_insert
  AFTER INSERT ON draft_pending_entities
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_page_words_on_insert();
CREATE TRIGGER caelo_draft_page_words_update
  AFTER UPDATE ON draft_pending_entities
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_page_words_on_update();
CREATE TRIGGER caelo_draft_page_words_delete
  AFTER DELETE ON draft_pending_entities
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_page_words_on_delete();
CREATE TRIGGER caelo_draft_page_words_truncate
  AFTER TRUNCATE ON draft_pending_entities
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_page_words_on_truncate();

/**
 * The words both tables should hold, from source: the page rows and the
 * page head rows of the draft. Shared by the rebuild and the drift check.
 */
CREATE FUNCTION caelo_page_search_words_expected()
  RETURNS TABLE (t text, chat_branch_id uuid, snapshot_row_id uuid, word text, page_id uuid)
LANGUAGE sql STABLE
AS $fn$
  SELECT 'live', NULL::uuid, NULL::uuid, w, p.id
    FROM pages p CROSS JOIN LATERAL caelo_search_words(p.title, p.short_title, p.slug) w
  UNION
  SELECT 'draft', d.chat_branch_id, s.id, w, s.page_id
    FROM draft_pending_entities d
    JOIN page_snapshots s ON s.id = d.snapshot_row_id
   CROSS JOIN LATERAL caelo_search_words(
     s.state->>'title', s.state->>'shortTitle', s.state->>'slug') w
   WHERE d.entity_kind = 'page'
$fn$;

/** Rebuild both word tables from source; returns how many rows they hold after. */
CREATE FUNCTION caelo_page_search_words_rebuild() RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  n bigint;
BEGIN
  DELETE FROM page_search_words;
  DELETE FROM draft_pending_page_words;
  INSERT INTO page_search_words (word, page_id)
  SELECT e.word, e.page_id FROM caelo_page_search_words_expected() e WHERE e.t = 'live';
  INSERT INTO draft_pending_page_words (chat_branch_id, snapshot_row_id, word, page_id)
  SELECT e.chat_branch_id, e.snapshot_row_id, e.word, e.page_id
    FROM caelo_page_search_words_expected() e WHERE e.t = 'draft';
  SELECT (SELECT count(*) FROM page_search_words)
       + (SELECT count(*) FROM draft_pending_page_words) INTO n;
  RETURN n;
END
$fn$;

SELECT caelo_page_search_words_rebuild();

ANALYZE page_search_words;
ANALYZE draft_pending_page_words;

COMMIT;
