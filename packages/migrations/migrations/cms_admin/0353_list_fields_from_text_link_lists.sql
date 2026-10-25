-- SPDX-License-Identifier: MPL-2.0
--
-- caelo:contract module fields of kind text-list / link-list become kind list; the previous image cannot render them
--
-- 0353 — epic #1107 part B: the `text-list` and `link-list` module field
-- kinds become fields of kind `list` holding a LOCAL list of the shipped
-- `texts` / `links` list types (docs/lists.md §7). One-way, for the
-- installs that already have such fields; no read path keeps the old
-- shapes alive (CLAUDE.md §2).
--
--   field definitions   {name,label,kind:"text-list",min?,max?,default?}
--                       → {name,label,kind:"list",listType:"texts",
--                          bind:"local",min?,max?,default?}
--                       (link-list → listType "links")
--   values              text-list "a"          → {id,node:"text",values:{text:"a"}}
--                       link-list {label,href} → {id,node:"link",
--                                                 values:{label,link:{href,target?}}}
--                       Every entry gets a fresh uuid. An empty href becomes
--                       "#", the same placeholder content_instances writes
--                       for an empty url.
--   module HTML         inside `{{#f}}…{{/f}}` of a converted field:
--                       `{{.}}` / `{{item}}` → `{{text}}` (texts) and
--                       `{{href}}` → `{{link}}` (links; a link field renders
--                       its href). Nothing outside those sections changes.
--
-- Converted: live module rows, every module snapshot (so a revert or a
-- Stage of a pending draft never brings an old field kind back), every
-- content instance and every content-instance snapshot of a module that
-- declared such a field anywhere (live or in a snapshot). A value that is
-- neither text nor a {label, href} item cannot be converted and aborts
-- the migration naming the row — fix or clear it, then migrate again.
-- The legacy pre-v0.12 page_module_content tables are history only and
-- stay as they are.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE FUNCTION pg_temp.lists_convert_value(kind text, v jsonb, at text) RETURNS jsonb AS $$
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
        RAISE EXCEPTION 'migration 0353: % holds a text-list item that is not text: %', at, e;
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
        RAISE EXCEPTION 'migration 0353: % holds a link-list item that is not a {label, href} object: %', at, e;
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

CREATE FUNCTION pg_temp.lists_convert_fields(fields jsonb, at text) RETURNS jsonb AS $$
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
CREATE FUNCTION pg_temp.lists_rewrite_html(html text, fields jsonb) RETURNS text AS $$
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

DO $$
DECLARE
  dup record;
BEGIN
  SELECT module_id, name INTO dup FROM _list_fields GROUP BY module_id, name HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'migration 0353: field "%" of module % is a text-list in one version and a link-list in another — make the versions agree (or revert the module), then migrate again', dup.name, dup.module_id;
  END IF;
END $$;

CREATE FUNCTION pg_temp.lists_convert_values(module_id uuid, vals jsonb, at text) RETURNS jsonb AS $$
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
