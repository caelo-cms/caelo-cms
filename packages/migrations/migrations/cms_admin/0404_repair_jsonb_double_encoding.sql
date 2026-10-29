-- SPDX-License-Identifier: MPL-2.0
--
-- 0404 — repair jsonb values stored double-encoded (#68).
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
      RAISE EXCEPTION '0404: % row(s) of %.% are still double-encoded after the repair',
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

COMMIT;
