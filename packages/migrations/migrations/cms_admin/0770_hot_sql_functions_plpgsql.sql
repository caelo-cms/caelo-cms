-- SPDX-License-Identifier: MPL-2.0
--
-- 0770 — issue #1685: the helper functions every request runs keep their
-- plans (the scale gate, #1267).
--
-- These functions are `LANGUAGE sql` with a subquery or a CTE in their
-- body, so Postgres cannot inline them. Postgres 17 then plans an SQL
-- function's body again in every statement that calls it (only the calls
-- within one statement share the plan), while a plpgsql function caches
-- its plans for the session. Each one runs in nearly every request:
--
--   - caelo_branch_visible: before every op that names a branch (#569).
--     The most expensive statement of the scale gate's load phase
--     (2,436 calls in 300 s); about 350 µs of planning per call against
--     about 35 µs for the same body in plpgsql;
--   - caelo_chat_owner: in every draft-head maintainer's source query, in
--     the branch check and in the MCP token principal;
--   - caelo_mcp_token_principal, caelo_mcp_tokens_manage_all: the RLS
--     policies of mcp_tokens and the remote-MCP tables, read on every MCP
--     request;
--   - caelo_operator_oauth_writer, can_approve_plugin_installation: write
--     policies (Google sign-in client, plugin approvals); rare, converted so
--     that no policy calls a function that plans per statement (the rule in
--     rls-planner.integration.test.ts);
--   - plugin_list_type_available: per row of every list-type read (0357);
--   - caelo_draft_content_value_hashes_insert, caelo_draft_page_words_insert:
--     from the draft-head maintainers on each snapshot insert (0596, 0603).
--
-- Each body is the same query as before, so every answer is the same. The
-- signatures, volatility and settings do not change, so the policies and
-- triggers that call them keep working, and the previous image reads
-- nothing different: expand-only.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE OR REPLACE FUNCTION caelo_chat_owner(task uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE
  AS $fn$
BEGIN
  RETURN COALESCE(
    (SELECT cs.parent_chat_session_id FROM chat_sessions cs WHERE cs.id = task),
    task
  );
END
$fn$;

CREATE OR REPLACE FUNCTION caelo_branch_visible(branch uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE
  AS $fn$
BEGIN
  RETURN (
    WITH raw AS (
      SELECT NULLIF(current_setting('caelo.actor_kind', true), '') AS kind,
             current_setting('caelo.actor_id', true) AS actor,
             current_setting('caelo.chat_task_id', true) AS task
    ),
    -- Only a well-formed uuid is cast: a malformed id names nobody.
    who AS (
      SELECT r.kind,
             CASE WHEN r.actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN r.actor::uuid END AS actor,
             CASE WHEN r.task ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN r.task::uuid END AS task,
             NULLIF(r.task, '') IS NULL AS no_task
      FROM raw r
    ),
    principal AS (
      SELECT w.kind, w.no_task,
             CASE
               WHEN w.kind = 'human' THEN w.actor
               WHEN w.kind = 'ai' THEN
                 (SELECT cs.created_by FROM chat_sessions cs WHERE cs.id = caelo_chat_owner(w.task))
             END AS person
      FROM who w
    )
    SELECT COALESCE(p.kind IS NOT NULL AND (
      p.kind IN ('system', 'plugin')
      OR (p.kind = 'ai' AND p.no_task)
      OR branch = (SELECT d.branch_id FROM site_draft d WHERE d.id = 1)
      OR EXISTS (
        SELECT 1 FROM chat_sessions cs
        WHERE cs.chat_branch_id = branch
          AND cs.created_by = p.person
      )
      OR (
        -- drafts.view_all opens every EXISTING branch only: a made-up id
        -- stays "not found" for an Owner too (chat_sessions is the
        -- registry of chat branches; the draft is matched above).
        EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.chat_branch_id = branch)
        AND EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN role_permissions rp ON rp.role_id = ur.role_id
          JOIN permissions pm ON pm.id = rp.permission_id
          WHERE ur.user_id = p.person AND pm.name = 'drafts.view_all'
        )
      )
    ), false)
    FROM principal p
  );
END
$fn$;

CREATE OR REPLACE FUNCTION caelo_mcp_token_principal() RETURNS uuid
  LANGUAGE plpgsql STABLE
  AS $fn$
BEGIN
  RETURN (
    WITH raw AS (
      SELECT NULLIF(current_setting('caelo.actor_kind', true), '') AS kind,
             current_setting('caelo.actor_id', true) AS actor,
             current_setting('caelo.chat_task_id', true) AS task
    ),
    -- Only a well-formed uuid is cast: a malformed id names nobody.
    who AS (
      SELECT r.kind,
             CASE WHEN r.actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN r.actor::uuid END AS actor,
             CASE WHEN r.task ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN r.task::uuid END AS task
      FROM raw r
    )
    SELECT CASE
             WHEN w.kind = 'human' THEN w.actor
             WHEN w.kind = 'ai' AND w.task IS NOT NULL THEN
               (SELECT cs.created_by FROM chat_sessions cs WHERE cs.id = caelo_chat_owner(w.task))
             WHEN w.kind = 'ai' THEN w.actor
           END
    FROM who w
  );
END
$fn$;

CREATE OR REPLACE FUNCTION caelo_mcp_tokens_manage_all() RETURNS boolean
  LANGUAGE plpgsql STABLE
  AS $fn$
BEGIN
  RETURN current_setting('caelo.actor_kind', true) = 'system'
    OR (current_setting('caelo.actor_kind', true) IN ('human', 'ai') AND EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = caelo_mcp_token_principal() AND p.name = 'settings.write'
    ));
END
$fn$;

CREATE OR REPLACE FUNCTION caelo_operator_oauth_writer() RETURNS boolean
  LANGUAGE plpgsql STABLE
  AS $fn$
BEGIN
  RETURN current_setting('caelo.actor_kind', true) = 'system'
    OR (current_setting('caelo.actor_kind', true) = 'human' AND EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id::text = current_setting('caelo.actor_id', true)
        AND p.name = 'settings.write'
    ));
END
$fn$;

CREATE OR REPLACE FUNCTION can_approve_plugin_installation() RETURNS boolean
  LANGUAGE plpgsql STABLE
  AS $fn$
BEGIN
  RETURN current_setting('caelo.actor_kind', true) = 'system' OR
    (current_setting('caelo.actor_kind', true) = 'human' AND EXISTS (
      SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
        AND u.deleted_at IS NULL AND p.name = 'plugins.install'));
END
$fn$;

CREATE OR REPLACE FUNCTION plugin_list_type_available(owner_plugin_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path TO 'pg_catalog', 'public'
  AS $fn$
BEGIN
  RETURN owner_plugin_id IS NULL OR EXISTS (
    SELECT 1 FROM public.plugins p WHERE p.id = owner_plugin_id AND p.status = 'active'
      AND (p.tier = 1 OR EXISTS (
        SELECT 1 FROM public.plugin_installation_versions v
        JOIN public.plugin_capability_grants g
          ON g.plugin_id = v.plugin_id AND g.artifact_digest = v.artifact_digest
        WHERE v.plugin_id = p.id AND v.status = 'active'
          AND p.manifest_json = v.manifest_json AND p.source_code = v.source_code
          AND g.capability = 'list_types' AND g.revoked_at IS NULL
      ))
  );
END
$fn$;

CREATE OR REPLACE FUNCTION caelo_draft_content_value_hashes_insert(p_branches uuid[], p_rows uuid[])
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
BEGIN
  INSERT INTO draft_pending_content_value_hashes
    (chat_branch_id, snapshot_row_id, field, hash, instance_id)
  SELECT k.b, s.id, h.field, h.hash, s.content_instance_id
    FROM unnest(p_branches, p_rows) AS k(b, r)
    JOIN content_instance_snapshots s ON s.id = k.r
   CROSS JOIN LATERAL caelo_content_value_hashes(s.state -> 'values') h
  ON CONFLICT DO NOTHING;
END
$fn$;

CREATE OR REPLACE FUNCTION caelo_draft_page_words_insert(p_branches uuid[], p_rows uuid[])
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
BEGIN
  INSERT INTO draft_pending_page_words (chat_branch_id, snapshot_row_id, word, page_id)
  SELECT k.b, s.id, w, s.page_id
    FROM unnest(p_branches, p_rows) AS k(b, r)
    JOIN page_snapshots s ON s.id = k.r
   CROSS JOIN LATERAL caelo_search_words(
     s.state->>'title', s.state->>'shortTitle', s.state->>'slug') w
  ON CONFLICT DO NOTHING;
END
$fn$;

COMMIT;
