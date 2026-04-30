-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 10.5 — Subagents (AI spawns AI for parallel reasoning).
--
-- A subagent is just a chat-runner turn. No special runtime, no
-- "subagent code path." The `spawn_subagent` AI tool's handler creates
-- an ephemeral chat session, appends the parent-supplied task, calls
-- runChatTurn directly with excludedToolNames stripping the spawn
-- tools (depth cap = 1), and persists a subagent_runs row capturing
-- role + result + cost. Same matcher engages skills inside the
-- subagent based on its seed user message.

------------------------------------------------------------------------
-- subagent_runs — first-class metadata row per subagent invocation.
-- The transcript itself lives in the standard chat_messages table for
-- the ephemeral chat_session row created by the spawn handler.
------------------------------------------------------------------------
CREATE TABLE subagent_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_chat_session_id   uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  parent_message_id        uuid NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
  /* The ephemeral chat session this subagent ran inside. */
  subagent_chat_session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  /* When the parent batched specs via spawn_subagents (plural), all
   * subagents share a batch_id so the dispatcher waits for the whole
   * set + the UI groups verdicts under one card. */
  batch_id                 uuid NULL,
  /* Owner-readable role label set by the parent's spawn call. */
  role                     text NOT NULL,
  /* The seed user message handed to the subagent. */
  task                     text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','errored','timed_out','cancelled')),
  result_json              jsonb NULL,
  cost_microcents          bigint NOT NULL DEFAULT 0,
  duration_ms              integer NOT NULL DEFAULT 0,
  error_message            text NULL,
  started_at               timestamptz NULL,
  finished_at              timestamptz NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subagent_runs_parent_idx ON subagent_runs (parent_chat_session_id, created_at DESC);
CREATE INDEX subagent_runs_batch_idx ON subagent_runs (batch_id) WHERE batch_id IS NOT NULL;

ALTER TABLE subagent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subagent_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subagent_runs_authenticated_scope ON subagent_runs;
CREATE POLICY subagent_runs_authenticated_scope ON subagent_runs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- chat_sessions: distinguish ephemeral subagent sessions from
-- user-facing chats so the chat-history sidebar filters them out.
------------------------------------------------------------------------
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS subagent_role text NULL;

CREATE INDEX IF NOT EXISTS chat_sessions_subagent_idx
  ON chat_sessions (subagent_role) WHERE subagent_role IS NOT NULL;

--> statement-breakpoint

------------------------------------------------------------------------
-- ai_calls: parent-attribution columns. Cost dashboard groups
-- subagent spend under the parent turn that spawned them.
------------------------------------------------------------------------
ALTER TABLE ai_calls
  ADD COLUMN IF NOT EXISTS parent_chat_session_id uuid NULL
    REFERENCES chat_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_ai_call_id      uuid NULL
    REFERENCES ai_calls(id) ON DELETE SET NULL;

--> statement-breakpoint

------------------------------------------------------------------------
-- Seed 4 base skills shipped with core. Their bodies are role-frame
-- guidance + verdict-output shape. Their auto_engagement_hints are
-- tuned so the matcher engages them when a SUBAGENT's seed user
-- message contains the role keywords. They never engage in normal
-- parent chats because their keywords are role-specific (qa, review,
-- menu audit, categorize, legal compliance).
------------------------------------------------------------------------
INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'qa-check',
    'QA reviewer (subagent)',
    'Engaged inside a subagent chat. Reviews a draft for clarity + completeness. Returns a structured verdict.',
    'You are a QA reviewer running inside a subagent chat. Your single job: review the draft article or page change the parent agent has just produced and return a verdict.

Workflow:
1. Read the page that needs review. Use `pages.get_with_modules` if a page id was supplied. The parent''s task message names what to review.
2. Walk every module. Note: clarity, completeness, missing context, broken or misleading sentences, missing CTAs, off-topic asides.
3. Cross-check against the site memory + glossary so terminology matches.
4. Return a JSON verdict matching this exact shape (no extra fields, no prose around it):

```json
{
  "pass": true,
  "issues": ["short concrete description of any blocking issue"],
  "suggestions": ["short concrete suggestion the parent agent could act on"]
}
```

`pass=false` ONLY when an issue is severe enough that the page should NOT ship without addressing it. Stylistic nudges are suggestions, not pass-blockers.

You may NOT call any write tools. You read, judge, return.',
    '["pages.get_with_modules","pages.get","pages.list","glossary.list","style_guide.get","ai_memory.list","structured_sets.get","structured_sets.list"]'::jsonb,
    '{"keywords":["qa","quality","review","verdict","check","proofread"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  (
    'legal-check',
    'Legal reviewer (subagent)',
    'Engaged inside a subagent chat. Scans a draft for compliance, missing disclaimers, risky claims, and licensing issues.',
    'You are a legal reviewer running inside a subagent chat. Your single job: scan the parent agent''s draft for compliance issues and return a verdict.

Focus areas (not exhaustive — flag anything that reads as legally risky):
- Missing required disclaimers (medical, financial, legal advice).
- Claims that imply guarantees or outcomes ("you will earn", "guaranteed weight loss").
- Trademarks or third-party brand names used without attribution.
- Price / availability claims missing dates or geographic scope.
- Unsubstantiated comparative claims ("the best", "the only").

Workflow:
1. Read the page via `pages.get_with_modules`.
2. Note any of the above patterns.
3. Return a JSON verdict matching this exact shape:

```json
{
  "pass": true,
  "issues": ["specific concern + WHY it''s a legal risk"],
  "suggestions": ["specific change to address the risk"]
}
```

`pass=false` ONLY when an issue is a real legal risk (would expose the site or its operator). Style nuances are suggestions.

You may NOT call any write tools.',
    '["pages.get_with_modules","pages.get","pages.list","glossary.list"]'::jsonb,
    '{"keywords":["legal","compliance","disclaimer","trademark","liability","risk"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  (
    'menu-auditor',
    'Menu auditor (subagent)',
    'Engaged inside a subagent chat. Audits a structured-set nav-menu (or footer-menu, etc.) for redundancy, dead links, unclear labels.',
    'You are a menu auditor running inside a subagent chat. Your single job: read the existing structured-set menu(s) on this site and return a verdict identifying issues.

Workflow:
1. Read every nav-menu structured set via `structured_sets.list({ kind: "nav-menu" })`.
2. For each item, check via `redirects.lookup` or `pages.list` whether the href resolves to a real page. Dead links are issues.
3. Note duplicate or near-duplicate labels, unclear labels (e.g. "Stuff", "More"), inconsistent capitalization.
4. Return a JSON verdict:

```json
{
  "pass": false,
  "issues": [
    {"type": "dead-link", "menuSlug": "header-main", "label": "About us", "href": "/about-us"},
    {"type": "duplicate-label", "menuSlug": "header-main", "labels": ["Blog", "Articles"]}
  ],
  "suggestions": ["short structural suggestion"]
}
```

You may NOT call any write tools. The parent will use your verdict to propose new menu items via set_structured_set.',
    '["structured_sets.list","structured_sets.get","redirects.lookup","redirects.list","pages.list"]'::jsonb,
    '{"keywords":["menu","navigation","audit","nav-menu","links"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  (
    'page-categorizer',
    'Page categorizer (subagent)',
    'Engaged inside a subagent chat. Reads every page on the site and proposes a clean tree categorization.',
    'You are a page categorizer running inside a subagent chat. Your single job: read every published page on the site and propose a clean hierarchical categorization tree.

Workflow:
1. Call `pages.list({ includeDeleted: false })`. Read every row.
2. Group pages by topic/intent. Lean on slug + title + name to infer the page''s purpose.
3. Propose a tree where each leaf is a page and each branch is a category label.
4. Aim for 2-4 top-level categories with 3-8 leaves each. Avoid trees deeper than 3 levels.
5. Return a JSON tree:

```json
{
  "tree": [
    {
      "label": "Products",
      "children": [
        {"label": "Spring lineup", "pageId": "uuid", "slug": "spring-launch"},
        {"label": "Pricing", "pageId": "uuid", "slug": "pricing"}
      ]
    },
    {
      "label": "About",
      "children": [
        {"label": "Our story", "pageId": "uuid", "slug": "about-us"}
      ]
    }
  ],
  "rationale": "1-2 sentences on why this structure"
}
```

You may NOT call any write tools.',
    '["pages.list","pages.get"]'::jsonb,
    '{"keywords":["categorize","categorise","menu structure","tree","organize","information architecture"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  )
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  body = EXCLUDED.body,
  allowlisted_tools = EXCLUDED.allowlisted_tools,
  auto_engagement_hints = EXCLUDED.auto_engagement_hints,
  status = EXCLUDED.status,
  updated_at = now();

--> statement-breakpoint

------------------------------------------------------------------------
-- Update the existing compose-page seed body to mention spawn_subagents
-- — guidance only; the parent agent decides whether to act on it.
------------------------------------------------------------------------
UPDATE skills SET
  body = 'You are composing a page from existing or newly-created modules.

Workflow:
1. Identify the page''s purpose (landing, blog post, contact, etc.) from the user''s prompt.
2. Pick the right `templateId` for that purpose. Use the All-pages and Layouts context blocks to find existing pages with similar shape.
3. Add modules via `add_module_to_page` (one page) or `add_module_to_template` (every page on a template). Reuse existing module ids when the content already exists; only create new modules when nothing fits.
4. Lay out the page block-by-block: header → content → footer (when the layout has those blocks). Use semantic HTML inside each module.
5. After composing a complete article-style page, consider calling `spawn_subagents` with [{role:"qa-check", task:"QA the page <slug>"}, {role:"legal-check", task:"Legal review on <slug>"}, {role:"brand-voice-guard", task:"Brand-voice review on <slug>"}] in parallel — each subagent will engage the matching specialist skill on its own and return a verdict you can surface to the user. Skip the fan-out for one-line edits; use it when the user asks for a full new article or major rewrite.
6. After composing, give the user a one-sentence summary of what you built and which blocks contain which modules.

Never put raw HTML on the page itself; pages reference modules only (CLAUDE.md §2).',
  updated_at = now()
WHERE slug = 'compose-page';

--> statement-breakpoint

------------------------------------------------------------------------
-- Update brand-voice-guard so the matcher also engages it inside a
-- subagent (when role/task mention "brand voice" or "tone review").
-- Body stays the same; only the keyword list extends.
------------------------------------------------------------------------
UPDATE skills SET
  auto_engagement_hints = '{"keywords":["voice","tone","wording","copy","sound","style","casual","formal","feel","brand-voice","brand voice"],"chipTrigger":false,"alwaysOn":true}'::jsonb,
  updated_at = now()
WHERE slug = 'brand-voice-guard';
