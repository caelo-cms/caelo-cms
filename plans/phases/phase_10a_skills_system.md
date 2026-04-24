# Phase 10A — Skills system + auto-engagement + base skills

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P5 (AI + chat sessions), P3/P7/P8 (surfaces used by base skills), P10 (translation flows become skills).
**Unblocks:** P12 (summarize-plugin-data skill), P12A (per-plugin companion skills).

## Goal (from master plan)
Claude-style skills as first-class core capability stored in `cms_admin.skills`. **Two levels of "activation"** — site-wide (human Owner required) and per-chat engagement (AI auto-matcher + user manual override). AI auto-engages contextually relevant skills per call; users see an Engaged Skills panel with rationale and can manually engage/disengage for the current chat. New chats revert to matcher defaults; engagements persist per chat session. AI can author/update skills through the normal preview → snapshot → confirm path; new-skill site-wide activation requires human Owner. Behaviour-learned proposals queue from repeated corrections; nothing auto-applies. Ship base skills so AI is useful from day one.

## End-to-end verification
"create a new pricing page" auto-engages `compose-page` without any user click; Engaged Skills panel shows rationale; user manually disengages `brand-voice-guard` for this chat → persists for chat life and overrides matcher; new chat reverts to matcher defaults; behaviour-learned proposal queued after 3 consecutive same-type user rewrites; Owner approves → skill is site-wide-active after human confirm.

## To be detailed before execution
- **`skills` table:** id, name (unique), version, description, trigger_hints (keywords / regex / semantic tags), system_prompt_body, tool_allowlist (string[]), examples JSON, **status** (`draft`, `awaiting_activation`, `active`, `disabled`) — **site-wide lifecycle only**. Per-chat engagement lives on `chat_sessions`, not here.
- **`chat_session_skill_state`** (or the `engaged_skills` JSON on `chat_sessions` from P5): per-chat, records `{skill_id, source: 'auto'|'user', engaged_at}` for engaged skills plus a separate `user_disengaged: skill_id[]` list. User overrides always take precedence over the matcher.
- **`skill_pinned_defaults`** (per-user): a set of skill ids that auto-engage on every new chat for that user.
- **`skill_proposals` table:** source (`ai_suggestion`, `correction_pattern`), rationale, proposed_skill JSON, status (`pending`, `approved`, `rejected`), reviewer, reviewed_at.
- **Per-call matcher (auto-engagement):** scores site-active skills vs the current user message + chat context (page, locale, plugins in scope, recent tool calls); top-K matches become *engaged* for the next AI call. Each engagement records rationale (which trigger hint fired, semantic score) for the Engaged Skills panel. Engagement state persists to the chat session so resume restores behaviour.
- **System-prompt composition order:** `site_ai_memory` (P5) → engaged-skill bodies (concat) → base system prompt. Union of engaged-skill `tool_allowlist` narrows but never widens the caller's existing tool permissions.
- **Engaged Skills panel (right side of chat UI):** shows each currently-engaged skill with `source` badge (auto / user) and rationale; toggle buttons to engage / disengage; a "Pin as default" action writes to `skill_pinned_defaults`.
- **Manual overrides:** user disengagement persists for the life of the chat; matcher will *not* re-engage a user-disengaged skill in that chat. Manual engagement similarly persists and is shown with `source='user'`.
- **Authoring tool surface:** AI tools `skills.draft`, `skills.update` (require user confirm + snapshot); `skills.activate` (site-wide) rejects AI actors — human Owner only. Engagement toggles go through separate, always-available chat-scoped ops that do not require confirmation.
- **Behaviour-learner:** background job scans the audit log for repeated user-correction patterns and emits `skill_proposals`; never auto-activates, never auto-engages.
- **Base skills shipped with core** (all arrive as site-wide-active on first install):
  - `compose-page` — orchestrates module picks + copy writes + SEO autofill + image requests; auto-engages on "create / build / compose a … page" intents
  - `explain-page` — a11y/SEO/readability audit; auto-engages on "audit / explain / why is this page …" intents
  - `brand-voice-guard` — hard-checks output against `site_ai_memory`; auto-engages on any content-writing tool call
  - `translation-mode-1` / `translation-mode-2` — auto-engage when the current page is a translation variant (status `not_started` or `needs_update` respectively)
  - `seo-autofill` — runs once per page before first publish to populate SEO fields; never auto-overwrites
  - `seo-optimize` — explicit cross-page SEO optimization; takes `{page_ids[], optimization_intent, user_context}` (e.g. keyword analysis for 5 t-shirt pages) and produces a batched preview for one-shot confirm
  - `summarize-plugin-data` — auto-engages on plugin-data analysis intents
  - `scoped-edit` — auto-engages when the chat composer carries element-reference chips from P5; constrains AI to the referenced elements; supports multi-element operations ("make all five green") in a single turn
  - `import-site` — drives the Site Import Wizard (P14); scrapes a supplied URL, drafts modules + typed content + media, stages a site snapshot with per-page screenshot-diff design verification
  - `site-memory-learner` — detects repeated user corrections / preferences and writes proposals to the `site_memory_proposals` queue (Owner review, never auto-applies)
- **Skill revert:** skill changes snapshot like any other entity; revert via the P4 Advanced History drawer.
- **Adversarial tests:** AI actor attempts `skills.activate` (site-wide) → rejected; behaviour-learner never auto-applies; skills cannot widen tool allowlist past caller; user-disengaged skill is never re-engaged by the matcher in the same chat; new chat correctly reverts to matcher + pinned defaults.
