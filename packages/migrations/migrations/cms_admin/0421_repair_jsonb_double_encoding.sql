-- SPDX-License-Identifier: MPL-2.0
--
-- 0421 — repair jsonb values stored double-encoded (#68).
--
-- Until #283 (migration 0136 was the newest then) the ops wrote jsonb as
-- `${JSON.stringify(x)}::jsonb`. bun:SQL binds a JS string under a bare
-- `::jsonb` cast as a jsonb STRING scalar, so those rows hold
-- `"{\"a\":1}"` (jsonb_typeof = 'string') instead of `{"a":1}`. Readers
-- hid it with a `typeof v === "string" ? JSON.parse(v) : v` fallback;
-- jsonb operators (`@>`, `->`), CHECKs and direct reads saw the wrong
-- shape. #283 fixed the writes; this repairs the rows written before,
-- so the read-side fallbacks can go (CLAUDE.md §2: no hidden fallbacks).
--
-- Affected columns: every jsonb column of the tables that existed at 0136
-- and still exist (the list below is that intersection, computed from a
-- database migrated to 0136 vs one migrated to head). Tables created
-- later were only ever written through `jsonbParam` / `::text::jsonb`.
--
-- Only a string scalar whose text is itself a JSON object or array is
-- rewritten (unwrapped repeatedly, for a value encoded more than twice);
-- a genuine string value, or one that is not JSON, stays as it is.
-- Idempotent: a second run finds nothing to change. Expand-safe: the
-- previous release's readers still parse a string, and accept the object.
--
-- 0353 (epic #1107) converted `text-list` / `link-list` module fields to
-- local lists, but only in rows whose jsonb it could read — a
-- double-encoded `modules.fields` or `content_instances.values` was
-- skipped and, once repaired here, would come back with a field kind no
-- reader supports. So after the repair this migration runs 0353's
-- conversion again, copied from 0353 (CREATE OR REPLACE, messages name
-- 0421). It touches only fields still of the old kinds, and leaves values
-- already in list shape alone, so on an install without such rows it
-- changes nothing.
--
-- RLS: every listed table admits the system actor except
-- user_preferences, which admits only the row's own user, so its rows are
-- repaired per user.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

-- The object/array a double-encoded value holds, or NULL when `v` is not
-- a string scalar wrapping JSON text of an object or array.
CREATE OR REPLACE FUNCTION pg_temp.caelo_unwrap_jsonb(v jsonb) RETURNS jsonb AS $$
DECLARE
  cur jsonb := v;
  i int := 0;
BEGIN
  WHILE cur IS NOT NULL AND jsonb_typeof(cur) = 'string' AND i < 8 LOOP
    BEGIN
      cur := (cur #>> '{}')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN NULL;
    END;
    i := i + 1;
  END LOOP;
  IF i = 0 OR cur IS NULL OR jsonb_typeof(cur) NOT IN ('object', 'array') THEN
    RETURN NULL;
  END IF;
  RETURN cur;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $$
DECLARE
  col record;
  u record;
  left_over bigint;
BEGIN
  FOR col IN
    SELECT t.tbl, t.col
      FROM (VALUES
    ('ai_providers', 'config'),
    ('ai_providers_pending_actions', 'payload'),
    ('ai_providers_pending_actions', 'preview'),
    ('chat_messages', 'attachments'),
    ('chat_messages', 'thinking_blocks'),
    ('chat_messages', 'tool_calls'),
    ('chat_sessions', 'auto_engaged_skills'),
    ('chat_sessions', 'engaged_skills'),
    ('chat_sessions', 'pinned_elements'),
    ('content_instance_snapshots', 'state'),
    ('content_instances', 'values'),
    ('deploy_pending_actions', 'payload'),
    ('deploy_pending_actions', 'preview'),
    ('deploy_runs', 'progress'),
    ('deploy_runs', 'publish_summary'),
    ('deploy_targets', 'provisioner_state'),
    ('domain_pending_actions', 'payload'),
    ('domain_pending_actions', 'preview'),
    ('email_config', 'config_json'),
    ('email_config_pending_actions', 'payload'),
    ('email_config_pending_actions', 'preview'),
    ('import_pages', 'notes'),
    ('import_pages', 'proposed_modules'),
    ('import_pages', 'proposed_theme_tokens'),
    ('import_pages', 'sampled_design_tokens'),
    ('import_runs', 'crawl_state'),
    ('import_runs', 'estimate'),
    ('import_runs', 'site_design_tokens'),
    ('layout_pending_actions', 'payload'),
    ('layout_pending_actions', 'preview'),
    ('mcp_token_pending_actions', 'payload'),
    ('mcp_token_pending_actions', 'preview'),
    ('module_snapshots', 'state'),
    ('modules', 'fields'),
    ('page_layout_snapshots', 'state'),
    ('page_module_content', 'content_values'),
    ('page_module_content_snapshots', 'state'),
    ('page_snapshots', 'state'),
    ('plugins', 'manifest_json'),
    ('plugins', 'validation_errors'),
    ('provisioning_outputs', 'outputs_json'),
    ('role_pending_actions', 'payload'),
    ('role_pending_actions', 'preview'),
    ('site_defaults', 'design_brief'),
    ('site_defaults', 'organization_json'),
    ('site_settings', 'captcha_provider_config'),
    ('skill_proposals', 'allowlisted_tools'),
    ('skill_proposals', 'auto_engagement_hints'),
    ('skills', 'allowlisted_tools'),
    ('skills', 'auto_engagement_hints'),
    ('snapshot_revert_pending_actions', 'payload'),
    ('snapshot_revert_pending_actions', 'preview'),
    ('subagent_runs', 'result_json'),
    ('template_pending_actions', 'payload'),
    ('template_pending_actions', 'preview'),
    ('template_snapshots', 'state'),
    ('theme_pending_actions', 'payload'),
    ('theme_pending_actions', 'preview'),
    ('theme_snapshots', 'state'),
    ('themes', 'tokens'),
    ('tool_approval_actions', 'args'),
    ('tool_approval_actions', 'preview'),
    ('user_pending_actions', 'payload'),
    ('user_pending_actions', 'preview')
      ) AS t(tbl, col)
      -- A table dropped or column renamed by a later release is skipped.
      JOIN information_schema.columns c
        ON c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = t.col
       AND c.data_type = 'jsonb'
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = pg_temp.caelo_unwrap_jsonb(%I)
        WHERE jsonb_typeof(%I) = ''string'' AND pg_temp.caelo_unwrap_jsonb(%I) IS NOT NULL',
      col.tbl, col.col, col.col, col.col, col.col);
    EXECUTE format(
      'SELECT count(*) FROM %I
        WHERE jsonb_typeof(%I) = ''string'' AND pg_temp.caelo_unwrap_jsonb(%I) IS NOT NULL',
      col.tbl, col.col, col.col) INTO left_over;
    IF left_over > 0 THEN
      RAISE EXCEPTION '0421: % row(s) of %.% are still double-encoded after the repair',
        left_over, col.tbl, col.col;
    END IF;
  END LOOP;

  -- user_preferences: its policy admits only the row's own user.
  FOR u IN SELECT id FROM users LOOP
    PERFORM set_config('caelo.actor_id', u.id::text, true);
    UPDATE user_preferences SET value = pg_temp.caelo_unwrap_jsonb(value)
     WHERE user_id = u.id
       AND jsonb_typeof(value) = 'string' AND pg_temp.caelo_unwrap_jsonb(value) IS NOT NULL;
  END LOOP;
  PERFORM set_config('caelo.actor_id', '', true);
END;
$$;

-- ── 0353's list conversion, for the rows the repair made readable ──────

CREATE OR REPLACE FUNCTION pg_temp.lists_convert_value(kind text, v jsonb, at text) RETURNS jsonb AS $$
DECLARE
  e jsonb;
  arr jsonb;
  out jsonb := '[]'::jsonb;
  txt text;
  label text;
  href text;
  link jsonb;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN v;
  END IF;
  arr := CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END;
  FOR e IN SELECT value FROM jsonb_array_elements(arr) LOOP
    IF jsonb_typeof(e) = 'object' AND e ? 'node' AND e ? 'values' THEN
      out := out || jsonb_build_array(e);
      CONTINUE;
    END IF;
    IF kind = 'text-list' THEN
      IF jsonb_typeof(e) IN ('string', 'number', 'boolean') THEN
        txt := e #>> '{}';
      ELSIF jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'text') = 'string' THEN
        txt := e->>'text';
      ELSIF jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'label') = 'string' THEN
        txt := e->>'label';
      ELSE
        RAISE EXCEPTION 'migration 0421 (the list conversion of 0353): % holds a text-list item that is not text: %', at, e;
      END IF;
      out := out || jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'node', 'text',
        'values', jsonb_build_object('text', txt)));
    ELSE
      IF jsonb_typeof(e) = 'object' THEN
        label := COALESCE(e->>'label', '');
        href := COALESCE(NULLIF(btrim(e->>'href'), ''), '#');
        link := jsonb_build_object('href', href);
        IF e->>'target' IN ('_self', '_blank') THEN
          link := link || jsonb_build_object('target', e->>'target');
        END IF;
      ELSIF jsonb_typeof(e) = 'string' THEN
        label := e #>> '{}';
        link := jsonb_build_object('href', '#');
      ELSE
        RAISE EXCEPTION 'migration 0421 (the list conversion of 0353): % holds a link-list item that is not a {label, href} object: %', at, e;
      END IF;
      out := out || jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'node', 'link',
        'values', jsonb_build_object('label', label, 'link', link)));
    END IF;
  END LOOP;
  RETURN out;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.lists_convert_fields(fields jsonb, at text) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(
    CASE WHEN f->>'kind' IN ('text-list', 'link-list') THEN
      jsonb_strip_nulls(jsonb_build_object(
        'name', f->'name',
        'label', f->'label',
        'kind', 'list',
        'listType', CASE WHEN f->>'kind' = 'text-list' THEN 'texts' ELSE 'links' END,
        'bind', 'local',
        'min', f->'min',
        'max', f->'max'))
      || CASE WHEN f ? 'default' AND jsonb_typeof(f->'default') <> 'null' THEN
           jsonb_build_object('default',
             pg_temp.lists_convert_value(f->>'kind', f->'default',
               at || ' field "' || (f->>'name') || '" default'))
         ELSE '{}'::jsonb END
    ELSE f END
    ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(fields) WITH ORDINALITY AS x(f, ord);
$$ LANGUAGE sql;

-- Rewrite `{{.}}` / `{{item}}` / `{{href}}` inside the sections of every
-- converted field of `fields` (the OLD field list) in `html`.
CREATE OR REPLACE FUNCTION pg_temp.lists_rewrite_html(html text, fields jsonb) RETURNS text AS $$
DECLARE
  f jsonb;
  name text;
  open_re text;
  close_re text;
  m text[];
  whole text;
  pos int;
  inner_html text;
  rest text;
  out text;
BEGIN
  IF html IS NULL OR fields IS NULL OR jsonb_typeof(fields) <> 'array' THEN
    RETURN html;
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(fields) LOOP
    CONTINUE WHEN f->>'kind' NOT IN ('text-list', 'link-list');
    name := f->>'name';
    CONTINUE WHEN name IS NULL OR name !~ '^[a-z][a-z0-9_]*$';
    open_re := '\{\{\s*#\s*' || name || '\s*\}\}';
    close_re := '\{\{\s*/\s*' || name || '\s*\}\}';
    out := '';
    rest := html;
    LOOP
      m := regexp_match(rest, '(' || open_re || ')((?:(?!' || close_re || ').)*)(' || close_re || ')');
      EXIT WHEN m IS NULL;
      whole := m[1] || m[2] || m[3];
      -- The first literal occurrence of the matched text is the match.
      pos := strpos(rest, whole);
      inner_html := CASE WHEN f->>'kind' = 'text-list'
        THEN regexp_replace(m[2], '\{\{\s*(\.|item)\s*\}\}', '{{text}}', 'g')
        ELSE regexp_replace(m[2], '\{\{\s*href\s*\}\}', '{{link}}', 'g') END;
      out := out || substr(rest, 1, pos - 1) || m[1] || inner_html || m[3];
      rest := substr(rest, pos + length(whole));
    END LOOP;
    html := out || rest;
  END LOOP;
  RETURN html;
END;
$$ LANGUAGE plpgsql;

-- Every (module, field) that is a text-list / link-list anywhere: the
-- live row or any of its snapshots. Collected before anything changes.
DROP TABLE IF EXISTS _list_fields;
CREATE TEMP TABLE _list_fields ON COMMIT DROP AS
SELECT DISTINCT module_id, f->>'name' AS name, f->>'kind' AS kind
FROM (
  SELECT m.id AS module_id, m.fields AS fields FROM modules m
  UNION ALL
  SELECT ms.module_id, ms.state->'fields' FROM module_snapshots ms
   WHERE jsonb_typeof(ms.state->'fields') = 'array'
) src
CROSS JOIN LATERAL jsonb_array_elements(src.fields) AS f
WHERE jsonb_typeof(src.fields) = 'array' AND f->>'kind' IN ('text-list', 'link-list');

-- A field the live module now declares as another kind (a text-list that
-- became a text field) holds values of that kind: an old snapshot's
-- legacy kind, readable only since the repair above, must not convert
-- them. 0353 never saw such a snapshot, so this keeps what it left alone.
DELETE FROM _list_fields lf
 USING modules m
 CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(m.fields) = 'array' THEN m.fields ELSE '[]'::jsonb END) AS f
 WHERE m.id = lf.module_id
   AND f->>'name' = lf.name
   AND f->>'kind' NOT IN ('text-list', 'link-list', 'list');

DO $$
DECLARE
  dup record;
BEGIN
  SELECT module_id, name INTO dup FROM _list_fields GROUP BY module_id, name HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'migration 0421 (the list conversion of 0353): field "%" of module % is a text-list in one version and a link-list in another — make the versions agree (or revert the module), then migrate again', dup.name, dup.module_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.lists_convert_values(module_id uuid, vals jsonb, at text) RETURNS jsonb AS $$
DECLARE
  lf record;
BEGIN
  IF vals IS NULL OR jsonb_typeof(vals) <> 'object' THEN
    RETURN vals;
  END IF;
  FOR lf IN SELECT name, kind FROM _list_fields WHERE _list_fields.module_id = lists_convert_values.module_id LOOP
    IF vals ? lf.name THEN
      vals := jsonb_set(vals, ARRAY[lf.name],
        COALESCE(pg_temp.lists_convert_value(lf.kind, vals->lf.name, at || ' field "' || lf.name || '"'), 'null'::jsonb));
    END IF;
  END LOOP;
  RETURN vals;
END;
$$ LANGUAGE plpgsql;

UPDATE content_instances ci
   SET "values" = pg_temp.lists_convert_values(ci.module_id, ci."values", 'content_instance ' || ci.id)
 WHERE ci.module_id IN (SELECT module_id FROM _list_fields);

UPDATE content_instance_snapshots cis
   SET state = jsonb_set(cis.state, '{values}',
     pg_temp.lists_convert_values((cis.state->>'moduleId')::uuid, cis.state->'values',
       'content_instance_snapshot ' || cis.id))
 WHERE jsonb_typeof(cis.state->'values') = 'object'
   AND cis.state->>'moduleId' IN (SELECT module_id::text FROM _list_fields);

UPDATE modules m
   SET html = pg_temp.lists_rewrite_html(m.html, m.fields),
       fields = pg_temp.lists_convert_fields(m.fields, 'module ' || m.id)
 WHERE jsonb_typeof(m.fields) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.fields) f WHERE f->>'kind' IN ('text-list', 'link-list'));

UPDATE module_snapshots ms
   SET state = ms.state
     || jsonb_build_object(
          'html', pg_temp.lists_rewrite_html(ms.state->>'html', ms.state->'fields'),
          'fields', pg_temp.lists_convert_fields(ms.state->'fields', 'module_snapshot ' || ms.id))
 WHERE jsonb_typeof(ms.state->'fields') = 'array'
   AND jsonb_typeof(ms.state->'html') = 'string'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(ms.state->'fields') f WHERE f->>'kind' IN ('text-list', 'link-list'));


COMMIT;
