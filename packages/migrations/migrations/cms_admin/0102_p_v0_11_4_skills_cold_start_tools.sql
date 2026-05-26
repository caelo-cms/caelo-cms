-- SPDX-License-Identifier: MPL-2.0
-- v0.11.4 (issue #76 follow-up) — extend the `bootstrap-site` and
-- `compose-page` skills' tool allowlists to include the chat-first
-- cold-start tools: set_site_identity, set_theme_tokens,
-- set_theme_meta, list_theme_history, list_themes, get_theme,
-- set_theme_asset.
--
-- Background: the chat-runner intersects the active toolset against
-- the union of engaged skills' `allowlisted_tools` arrays. Without
-- these tools in the allowlist, the AI can't call them when those
-- skills are engaged — even though they're registered in the tool
-- registry. The AI's chat-message log surfaces this as
-- "the required tools aren't in my available toolset on this branch."
--
-- v0.11.4 introduces a cold-start gate on the module-creation tools
-- (compose_page_from_spec, add_module_to_page, etc.) — the gate
-- returns a structured error pointing at set_site_identity +
-- set_theme_tokens + set_theme_meta. For the AI to actually call
-- those tools, they have to be in the allowlist.
--
-- Idempotent JSONB array append: filters out names that are already
-- in the array, then appends only the missing ones. Re-running the
-- migration is safe.

DO $$
DECLARE
  cold_start_tools text[] := ARRAY[
    'set_site_identity',
    'set_theme_tokens',
    'set_theme_meta',
    'list_theme_history',
    'list_themes',
    'get_theme',
    'set_theme_asset'
  ];
  target_skills text[] := ARRAY['bootstrap-site', 'compose-page'];
  skill_slug text;
  tool_name text;
  current_tools jsonb;
BEGIN
  FOREACH skill_slug IN ARRAY target_skills LOOP
    SELECT allowlisted_tools INTO current_tools
      FROM skills WHERE slug = skill_slug;
    IF current_tools IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH tool_name IN ARRAY cold_start_tools LOOP
      IF NOT (current_tools @> to_jsonb(tool_name)) THEN
        current_tools := current_tools || to_jsonb(tool_name);
      END IF;
    END LOOP;
    UPDATE skills
      SET allowlisted_tools = current_tools
      WHERE slug = skill_slug;
  END LOOP;
END $$;
