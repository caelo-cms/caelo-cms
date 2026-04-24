# Phase 5 — AI provider abstraction + first AI module edit (Claude)

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P2, P3, P4.
**Unblocks:** P6 (MVP), P10 (translation), P16 (more providers).

## Goal (from master plan)
Provider abstraction layer configured only via the security control panel (never AI-accessible). Start with Claude (Anthropic SDK, Opus 4.7 via `claude-opus-4-7`). Token accounting table. Admin AI chat UI. First AI capability = edit one module via structured tool calls (no raw HTML writes to pages). **UX simplifications (UX-3, UX-8):** (a) *Auto-apply to a live preview pane by default* — individual AI edits are not gated behind a modal confirm; a persistent "Publish changes" pill batches pending diffs with a single confirm per publish event. Destructive / cross-page-impact changes keep their explicit confirm. (b) *Provider brand hidden from the chat UI* — editors see "AI"; brand surfaces only in the Owner security panel and cost dashboard. **Per-site AI session memory:** `site_ai_memory` table holding Owner-curated system-prompt snippets (brand voice, tone, banned phrases, recurring instructions); every AI call prepends this. Owner-only edit; versioned in snapshots. Deliverable: "make the hero headline blue" → live preview updates immediately → pill shows "1 pending change" → click Publish → snapshot; brand-voice snippet demonstrably shapes AI output across sessions.

## End-to-end verification
AI chat: **live preview auto-applies, "Publish changes" pill batches diffs**; provider brand absent from chat UI; **per-site brand-voice memory demonstrably shapes output across sessions**.

## To be detailed before execution
- Provider abstraction interface: `generate(messages, tools, options) → stream`.
- Anthropic SDK version (verify current) and Opus 4.7 model ID (`claude-opus-4-7`).
- Tool definitions exposed to AI for this phase: `edit_module(module_id, html?, css?, js?)` only.
- **Prompt caching** enabled on the system prompt + tool definitions (per skill:claude-api).
- **`site_ai_memory` table:** id, site_id, slot (`brand-voice`, `tone`, `banned-phrases`, `instructions`, …), body, updated_by, updated_at. Owner-only write; rendered into every system prompt.
- **`chat_sessions` table:** id, title (auto-derived from first user message, renameable), created_by, created_at, last_active_at, **engaged_skills JSON** (filled in P10A — structure: `{skill_id, source: 'auto'|'user', engaged_at}[]` plus `user_disengaged: skill_id[]` overrides).
- **`chat_messages` table:** id, chat_session_id, role (`user`/`assistant`/`tool`), content, tool_calls JSON, tokens_in, tokens_out, created_at.
- **Chat-title auto-derivation:** first user message → prompt a cheap / cached model call to produce a 4–8-word title; fallback to first N chars if the call fails.
- **Admin chat UI structure:**
  - Left sidebar: "New chat" button + list of prior chats (searchable, sorted by `last_active_at`, renameable, deletable with confirm).
  - Main pane: active conversation.
  - Right panel: Engaged Skills panel (populated in P10A) + per-site AI memory read-out (link to editor for Owners).
- **Ephemeral chat branches:** each chat session holds a `chat_branch_id`; all snapshots produced inside the chat carry that id and are visible only within the chat's preview branch. Publish merges the chat-branch snapshots into main (see P4). Parallel chats cannot see each other's in-progress changes.
- **Click-to-chat element references:** the preview pane injects a hover affordance per element (stable selector via data-attr generated at render time). Clicking serializes `{selector, module_id, current_content_hash, short_label}` and **appends it as a chip to the current chat composer** — never opens a new chat. Chips are removable before sending. On send, chips are passed to the AI as structured context; the `scoped-edit` skill (P10A) auto-engages whenever chips are present.
- **Visual content diff:** when the AI proposes changes, the preview pane renders a red/green visual overlay by re-running the generator against the proposed snapshot and diffing DOM / computed styles against the current state. Reuses the P4 thumbnailer. A toggle switches between visual and code diff.
- **AI-proposed site-memory additions:** a `site_memory_proposals` queue mirrors `skill_proposals`; the AI can call `site_memory.propose` mid-conversation; proposals surface in the Owner review queue and never auto-apply.
- Token accounting table: `ai_calls` (provider, model, input_tokens, output_tokens, cached_tokens, cost_estimate, actor, timestamp).
- **Live-preview flow:** AI tool-call output auto-applies to an in-memory preview session → diff rendered in a persistent "Publish changes" pill → on Publish, Query API write + snapshot → pill clears. Destructive / high-impact actions (per P4 severity) force an inline confirm before auto-apply.
- **Chat UI:** provider brand label absent; only a generic "AI" indicator. Brand surfaced in Owner security panel and P16 cost dashboard.
- Guardrails: AI cannot set page raw HTML (already blocked at Validator in P3 — verify here).
- Secrets: API keys via secrets manager abstraction; local dev reads from a local fake.
