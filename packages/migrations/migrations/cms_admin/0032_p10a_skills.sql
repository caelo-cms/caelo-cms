-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 10A — Skills system + auto-engagement.
--
-- Skills are Claude-style instructional bodies that augment the AI's
-- system prompt per call. Per CMS_REQUIREMENTS §17A and CLAUDE.md §2:
--   - Two distinct levels of activation:
--     1. Site-wide activation — Owner approves new skill before it
--        becomes a candidate at all (status: awaiting_activation → active).
--     2. Per-chat engagement — auto-matcher picks top-K active skills
--        per call; user can manually engage/disengage in any chat.
--   - AI can DRAFT skills via propose_skill; Owner reviews + activates.
--   - Behaviour-learned proposals land in the queue, never auto-applied.

------------------------------------------------------------------------
-- skills — instructional bodies. One row per skill slug. The matcher
-- reads `auto_engagement_hints` to score this skill against incoming
-- user messages; allowlisted_tools narrows the AI's tool catalogue
-- when this skill is engaged.
------------------------------------------------------------------------
CREATE TABLE skills (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     text NOT NULL UNIQUE,
  display_name             text NOT NULL,
  /* Owner / editor description shown in /security/skills. */
  description              text NOT NULL DEFAULT '',
  /* The full skill body — concatenated into the system prompt when engaged. */
  body                     text NOT NULL,
  /*
   * Tool-name allowlist used to narrow the catalogue when this skill
   * is engaged. Empty array means "this skill doesn't restrict tools."
   * The chat-runner intersects (union of all engaged skills' allowlists),
   * then intersects against the global tool catalogue. When NO engaged
   * skill restricts, the full catalogue is exposed.
   */
  allowlisted_tools        jsonb NOT NULL DEFAULT '[]'::jsonb,
  /*
   * Hints used by the auto-matcher (pure-keyword + chip-trigger scoring).
   * Shape: { keywords: string[], chipTrigger: boolean, alwaysOn: boolean }.
   * `keywords` boost the score when the user message mentions any.
   * `chipTrigger=true` engages this skill whenever element-ref chips
   * are present (e.g. scoped-edit). `alwaysOn=true` matches every call.
   */
  auto_engagement_hints    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                   text NOT NULL DEFAULT 'awaiting_activation'
    CHECK (status IN ('awaiting_activation', 'active', 'archived')),
  /* The actor who originally proposed this skill. NULL for seeded built-ins. */
  proposed_by              uuid NULL REFERENCES actors(id),
  /* The actor who flipped status to 'active' or 'archived'. */
  decided_by               uuid NULL REFERENCES actors(id),
  decided_at               timestamptz NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skills_status_idx ON skills (status, slug);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skills_authenticated_scope ON skills;
CREATE POLICY skills_authenticated_scope ON skills
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- skill_proposals — AI-curated proposed skills awaiting Owner review.
-- Same shape as ai_memory_proposals (P5). Accept → flips into `skills`
-- with status=awaiting_activation; Owner activates separately.
------------------------------------------------------------------------
CREATE TABLE skill_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_by   uuid NOT NULL REFERENCES actors(id),
  chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  slug          text NOT NULL,
  display_name  text NOT NULL,
  description   text NOT NULL DEFAULT '',
  body          text NOT NULL,
  rationale     text NOT NULL,
  allowlisted_tools     jsonb NOT NULL DEFAULT '[]'::jsonb,
  auto_engagement_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_by   uuid NULL REFERENCES actors(id),
  reviewed_at   timestamptz NULL,
  decision_note text NULL,
  /* When `accepted`, the skills.id row that was created (or updated). */
  resulting_skill_id uuid NULL REFERENCES skills(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_proposals_pending_idx
  ON skill_proposals (created_at DESC) WHERE status = 'pending';

ALTER TABLE skill_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_proposals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_proposals_authenticated_scope ON skill_proposals;
CREATE POLICY skill_proposals_authenticated_scope ON skill_proposals
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- skill_pin_defaults — per-user "always engage these in fresh chats."
-- Manual disengagement in a specific chat still wins; pinned defaults
-- are just the starting set.
------------------------------------------------------------------------
CREATE TABLE skill_pin_defaults (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id     uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill_id)
);

ALTER TABLE skill_pin_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_pin_defaults FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_pin_defaults_authenticated_scope ON skill_pin_defaults;
CREATE POLICY skill_pin_defaults_authenticated_scope ON skill_pin_defaults
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- chat_sessions: per-chat engagement state. Format:
--   [{ skillId, source: 'auto' | 'manual', rationale: string }]
-- Manual entries persist across turns within the chat; auto entries
-- are recomputed every turn from the matcher.
--
-- A nullable column means: NULL = matcher-default behaviour for this
-- chat (no manual overrides yet); empty array = explicit "no skills
-- engaged" override (user disengaged everything).
------------------------------------------------------------------------
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS engaged_skills jsonb NULL;

--> statement-breakpoint

------------------------------------------------------------------------
-- Seed the four base skills shipped with core. Status='active' so
-- they're matcher candidates immediately on a fresh install. Other
-- base skills (translation-mode-1/2, seo-autofill, seo-optimize,
-- summarize-plugin-data, import-site, site-memory-learner) ship as
-- data via Owner import — same path AI-curated skills travel through.
------------------------------------------------------------------------
INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'compose-page',
    'Compose a page',
    'Builds new pages from modules. Engaged when the user asks to create or fill a page.',
    'You are composing a page from existing or newly-created modules.

Workflow:
1. Identify the page''s purpose (landing, blog post, contact, etc.) from the user''s prompt.
2. Pick the right `templateId` for that purpose. Use the All-pages and Layouts context blocks to find existing pages with similar shape.
3. Add modules via `add_module_to_page` (one page) or `add_module_to_template` (every page on a template). Reuse existing module ids when the content already exists; only create new modules when nothing fits.
4. Lay out the page block-by-block: header → content → footer (when the layout has those blocks). Use semantic HTML inside each module.
5. After composing, give the user a one-sentence summary of what you built and which blocks contain which modules.

Never put raw HTML on the page itself; pages reference modules only (CLAUDE.md §2).',
    '["create_page","add_module_to_page","add_module_to_template","edit_module","reorder_module","move_module","change_template","duplicate_page"]'::jsonb,
    '{"keywords":["create","new page","build a page","compose","add page","make a page","start a page"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  (
    'explain-page',
    'Explain a page',
    'Describes what''s on a page in plain language. Engaged when the user asks "what is on this page?" / "describe this page" / "what does this do?"',
    'You are explaining a page''s content to a non-technical user.

Approach:
1. Walk the page''s blocks in render order (header → content → footer).
2. For each block, describe the modules within it: what they show + their purpose. Avoid HTML jargon — use phrases like "a hero with a headline and call-to-action button" rather than `<section><h1>`.
3. Note the page''s template (for context: blog post vs. landing vs. product detail) and any soft-deleted modules surfaced as `isDeleted` flags.
4. End with a one-line summary of what the page is FOR.

Never mention raw HTML, CSS classes, or module ids unless the user explicitly asks. The goal is editorial, not technical.',
    '[]'::jsonb,
    '{"keywords":["explain","describe","what is on","what does","summarize this page","walk me through","tell me about this page"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  (
    'brand-voice-guard',
    'Brand voice guard',
    'Ensures all generated copy matches the site''s brand voice + tone + glossary memory. Always-on when site_ai_memory has a brand-voice slot.',
    'You are a brand-voice gatekeeper for every word of new or edited copy.

Rules:
1. The site''s ## Brand voice and ## Tone memory slots define the voice. Re-read them on every turn before writing copy.
2. Banned phrases (## Banned phrases slot) MUST NOT appear in any generated text. If a phrase is banned, reword.
3. The site glossary defines exact term renderings. Use them verbatim — "CMS" stays "CMS", "Caelo" stays "Caelo", etc.
4. When the user gives a new persistent voice/tone instruction (e.g. "make all copy more casual"), call `site_memory_propose` so the Owner can persist it to memory.
5. When in doubt about voice, mirror the existing module HTML on the page rather than inventing a new tone.',
    '["site_memory_propose"]'::jsonb,
    '{"keywords":["voice","tone","wording","copy","sound","style","casual","formal","feel"],"chipTrigger":false,"alwaysOn":true}'::jsonb,
    'active'
  ),
  (
    'scoped-edit',
    'Scoped element edit',
    'Auto-engages when the chat composer has element-reference chips. Restricts edits to the chipped elements only.',
    'The user clicked one or more elements in the live preview before sending this message. Each chip references a specific module + selector.

Rules:
1. Operate ONLY on the modules the chips reference. Do not touch other modules on the page even if the request reads ambiguously.
2. When multiple chips are present, apply the same change to ALL of them in one tool call sequence — the user expects the change to land everywhere they clicked.
3. Use `edit_module` to change content fields. Never use `add_module_to_page` or any structural tool unless the user explicitly asks for structural change.
4. When the chips reference different modules with different shapes, apply the change to each one appropriately (e.g. "make these green" → set color on each module''s relevant element regardless of tag).
5. After the edit, briefly confirm which chipped elements were updated.',
    '["edit_module"]'::jsonb,
    '{"keywords":[],"chipTrigger":true,"alwaysOn":false}'::jsonb,
    'active'
  );
