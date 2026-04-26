# Phase 5 — AI provider abstraction + first AI module edit (Claude)

**Status:** ready to execute.
**Dependencies:** P2 (auth + permissions + audit), P3 (content primitives), P4 (snapshots — every AI tool call must produce a snapshot).
**Unblocks:** P6 (MVP — first runnable end-to-end product), P10 (translation modes use the same provider abstraction), P10A (skills system bolts onto the chat session model), P12 (auth plugin gets `analyze_plugin_data` access through the same provider), P16 (more providers).

## Goal

Editors can talk to "AI" in a chat panel and have it edit a module. The chat is grounded in a stable provider abstraction (Claude first; OpenAI / Gemini / local in P16) and an audit-grade token-accounting layer; chat messages and tool calls flow through the same Query API + snapshot path that human edits use, so every AI write is revertible exactly like a human one.

P5 is the smallest layer that proves the architecture end-to-end: one tool (`edit_module`), one provider (Claude Opus 4.7), the chat session shell that P10A's skills system will bolt onto, the ephemeral preview branch model that lets two editors work in parallel, and click-to-chat element references with the visual diff overlay that make the editor surface feel native rather than "tabbed AI". Per-site AI memory (brand voice, tone, banned phrases) is the only Owner-curated context that prepends every call.

This phase is heavier than P3/P4 because it crosses three new sub-systems (provider, chat, preview overlay). We split the schema landing into one migration so types stabilise early; the rest is mostly TypeScript.

## End-to-end verification

1. Owner enters an Anthropic API key in `/security/ai`; provider stub disappears.
2. Owner edits site-AI-memory ("brand voice: terse, no exclamation marks; banned phrase: 'cutting-edge'").
3. Editor opens `/content/chat`, clicks **New chat**.
4. Editor types: *"Make the hero headline blue and add a subheading."* → AI streams a response, calls `edit_module(...)` with HTML/CSS deltas → preview pane auto-applies → red/green visual diff overlay appears → Publish-changes pill shows `1 pending change`.
5. Editor clicks **Publish** → pill commits via the existing `pages.set_modules` / `modules.update` ops → P4 snapshot lands → /content/history shows the new entry attributed to the AI actor with the chat session id linked.
6. Editor opens a second chat in another tab and edits a different module → the two chats do not see each other's in-progress changes (ephemeral chat branches).
7. Editor clicks the inline pencil on three rendered elements → three chips accumulate in the composer → editor sends *"make them all green"* → AI uses the chip references to update three modules in one turn.
8. AI proposes a site-memory addition mid-conversation: *"You frequently ask for the CTA to be in title case — should I add 'CTA buttons in title case' to site memory?"* → Owner sees it in the review queue at `/security/ai/memory-proposals`; nothing auto-applies.
9. The cost dashboard at `/security/costs` (still a stub from P2.1) now shows `ai_calls` rows with input/output/cached token counts and an estimated cost.
10. Switch the provider to Claude Opus 4.7 (already default), verify the chat keeps streaming. The provider brand label is absent from the editor chat UI; it appears only in the Owner security panel and the cost dashboard.

Each step has a Bun integration test where it can run against the recorded provider fixture; the editor flow has a Playwright spec.

## Scope decisions

- **One tool only:** `edit_module(module_id, displayName?, html?, css?, js?)`. Multi-page edits, page composition, template edits, scoped element edits across many modules — all deferred. P5 proves the architecture; P10A and beyond widen the toolset.
- **One provider only:** Claude Opus 4.7 (`claude-opus-4-7`). Other providers wait for P16. The abstraction is shipped as `interface AIProvider` so swapping is a code change in P16, not a refactor.
- **`actorScope` widens to `"ai"`** on `modules.update` (and only `modules.update`) for P5. AI cannot reach `pages.*`, `templates.*`, or `template_blocks.set` yet — those land per-tool as later phases need them. This is the literal "module-only" surface the requirements call for at this stage.
- **Ephemeral chat branch = a `chat_branch_id` UUID** on `site_snapshots` (already reserved in P4). Each chat session creates one. All AI-emitted snapshots in the chat carry it. The `pages.list_with_branch` / `modules.get_with_branch` reads in P5 prefer chat-branch snapshots over main when a `chat_branch_id` is set. Publish = re-emit the latest chat-branch snapshots as main snapshots (no `chat_branch_id`) and clear the chat's branch pointer. **This is one of the heavier pieces of the phase; the simpler alternative below is the fallback.**
  - **Fallback if branch reads prove too invasive:** ship "publish-on-every-tool-call" instead, with the Publish pill becoming a UI nicety over the existing live-write semantics. Two parallel editors then race exactly like P3 — last write wins. Decision in week 1; flagged at the end-of-phase risks section.
- **Token accounting is a write-side log only.** No real-time budget enforcement here. The `ai_calls` table records every call; P16 wires per-actor / per-op-type budgets and the dashboard. Until then `/security/costs` shows aggregates from `ai_calls` directly.
- **Skills system stays in P10A.** P5 ships `chat_sessions.engaged_skills` as a JSON column with empty default; P10A populates it. The chat works without any skill engagement — system prompt is just `site_ai_memory` + tool definitions.
- **Provider brand absent from editor chat UI.** Hard rule. The brand string `"Claude"` only appears in `/security/ai/*` and `/security/costs`. The chat label is just "AI". Tested by a Playwright assertion that the chat HTML never contains the provider name.
- **Visual diff overlay reuses the P3 preview composer.** It re-runs `composePagePreview` against the *proposed* snapshot state, gets the second HTML, and DOM-diffs the two. No headless browser thumbnailer in P5 — the requirement says "visual content diff" and we interpret that as DOM-tree red/green at the element level. Real screenshot diffs land in P6 with the static generator.
- **Click-to-chat affordance lives in the preview iframe.** Each rendered element gets a `data-caelo-target="${moduleId}|${selector}"` attribute injected by the preview composer at render time. The iframe posts a `caelo:edit-element` message to the parent on click; the parent appends a chip to the composer. No iframe-cross-origin pain because the iframe loads from the same origin.
- **Site memory is a proposal queue, not direct writes.** AI calls a `site_memory.propose` tool whose handler writes to a queue table; Owners review at `/security/ai/memory-proposals` and accept/reject. Direct site memory writes go through the existing `/security/ai` Owner-only form.
- **Streaming SSE, not WebSocket.** SvelteKit endpoint streams tool-call deltas via SSE. WebSocket is overkill for one-direction streams and adds connection-state complexity that P5 doesn't need.
- **Secrets via env var in dev, secrets manager in production.** P5 reads `ANTHROPIC_API_KEY` from `process.env`. P14 will land the real secrets-manager abstraction; P5 plugs into it transparently because the provider takes the key as a constructor argument, not a global.

## Schema additions

Migration `0011_p5_ai_chat.sql`. Hand-written, RLS inline.

```
site_ai_memory
  id              uuid pk
  slot            text not null check (slot in ('brand-voice','tone','banned-phrases','instructions','glossary'))
  body            text not null
  updated_by      uuid not null references actors(id)
  updated_at      timestamptz not null default now()
  unique (slot)                          -- one row per slot; updates replace

ai_providers
  id              uuid pk
  name            text not null check (name in ('anthropic','openai','google','local-openai-compat'))
  display_name    text not null
  config          jsonb not null         -- model id, base URL, etc — never the key
  /* The API key is NOT stored here. Lives in the secrets manager / env;
     the provider name is the lookup key. P14 wires the secrets manager. */
  is_active       boolean not null default false
  created_at      timestamptz not null default now()

chat_sessions
  id              uuid pk
  title           text not null          -- auto-derived from first user message, renameable
  created_by      uuid not null references actors(id)
  chat_branch_id  uuid not null unique   -- this chat's ephemeral preview branch
  engaged_skills  jsonb not null default '{}'::jsonb  -- {skill_id, source, engaged_at}[]+overrides; P10A populates
  created_at      timestamptz not null default now()
  last_active_at  timestamptz not null default now()
  published_at    timestamptz null       -- non-null when the chat's branch has been merged into main
  archived_at     timestamptz null       -- soft-archive for old chats

chat_messages
  id              uuid pk
  chat_session_id uuid not null references chat_sessions(id) on delete cascade
  role            text not null check (role in ('user','assistant','tool'))
  content         text not null          -- assistant streamed text or user prompt; tool results stringified
  tool_calls      jsonb null             -- when role='assistant' and the model called tools
  tool_call_id    text null              -- when role='tool' and we're returning a result
  tokens_in       integer null           -- per-message token counts (assistant rows only)
  tokens_out      integer null
  cached_tokens   integer null
  created_at      timestamptz not null default now()

ai_calls
  id              uuid pk
  chat_session_id uuid null references chat_sessions(id) on delete set null
  actor_id        uuid not null references actors(id)
  provider        text not null
  model           text not null
  input_tokens    integer not null
  output_tokens   integer not null
  cached_tokens   integer not null default 0
  cost_estimate_microcents bigint not null  -- store as integer microcents to avoid float drift
  duration_ms     integer not null
  succeeded       boolean not null
  created_at      timestamptz not null default now()

site_memory_proposals
  id              uuid pk
  proposed_by     uuid not null references actors(id)  -- the AI actor's row
  chat_session_id uuid null references chat_sessions(id) on delete set null
  slot            text not null
  body            text not null
  rationale       text not null
  status          text not null default 'pending' check (status in ('pending','accepted','rejected'))
  reviewed_by     uuid null references actors(id)
  reviewed_at     timestamptz null
  created_at      timestamptz not null default now()
```

Indexes: `chat_messages(chat_session_id, created_at)`, `ai_calls(actor_id, created_at desc)`, `ai_calls(created_at desc)` for the dashboard, `site_memory_proposals(status, created_at desc)`, `chat_sessions(created_by, last_active_at desc)`.

RLS:
- `site_ai_memory`: read for any authenticated actor (system prompt prepends it for everyone); write only for `settings.write` (Owner). Enforce in app layer; RLS open per-actor for reads.
- `ai_providers`: read for any auth; write Owner-only.
- `chat_sessions`: rows owned by `created_by` — caller sees their own + Owners see all (Owner audit).
- `chat_messages`: same scope as parent session.
- `ai_calls`: read for `settings.read` (cost dashboard); write happens system-side via the call wrapper.
- `site_memory_proposals`: read for `settings.read`; create for any in-scope AI/human caller; update (review) Owner-only.

## Provider abstraction

`packages/admin-core/src/ai/provider.ts`:

```typescript
export interface AIProvider {
  readonly name: "anthropic" | "openai" | "google" | "local-openai-compat";
  readonly model: string;
  generate(input: GenerateInput): AsyncIterable<ProviderEvent>;
}

interface GenerateInput {
  systemPrompt: string;        // site_ai_memory + tool definitions baked in
  messages: ChatMessage[];     // role + content + optional tool_calls
  tools: ToolDefinition[];     // edit_module + site_memory.propose at P5
  cacheBreakpoints?: ("system" | "tools")[];  // prompt-cache hints
}

type ProviderEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; id: string; name: string; arguments: unknown }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number }
  | { kind: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" }
  | { kind: "error"; message: string };
```

`packages/admin-core/src/ai/providers/anthropic.ts` implements this with the official `@anthropic-ai/sdk`. Prompt caching enabled on `system` + `tools` per the API guide — call site sets cache breakpoints once and lets the SDK do the rest.

The Provider Abstraction Layer is the **only** code that knows the brand name. The chat surface (UI, message storage, tool dispatch) treats the provider as opaque.

## Tool dispatch

`packages/admin-core/src/ai/tools/edit-module.ts`:

```typescript
export const editModuleTool = defineTool({
  name: "edit_module",
  description: "Edit one module's HTML, CSS, JS, or display name. Page-layout changes use a different tool.",
  schema: z.object({
    moduleId: z.string().uuid(),
    displayName: z.string().min(1).max(128).optional(),
    html: z.string().max(MODULE_HTML_MAX).optional(),
    css: z.string().max(MODULE_CSS_MAX).optional(),
    js: z.string().max(MODULE_JS_MAX).optional(),
  }),
  /** Calls modules.update inside the chat's ephemeral branch. */
  handler: async (ctx, input, { adapter, registry, chatSession }) => {
    const result = await execute(registry, adapter, ctx, "modules.update", input);
    return result.ok
      ? { kind: "ok", message: "module updated" }
      : { kind: "error", message: (result.error as { message: string }).message };
  },
});
```

P5 ships exactly two tools: `edit_module` and `site_memory.propose`. The dispatch infrastructure in `ai/tools/dispatch.ts` is generic — adding a new tool in a later phase just adds a file.

`actorScope` on `modules.update` widens to `["human", "ai", "system"]` for P5. Other content ops stay `["human", "system"]` until their corresponding tools land.

## Chat session lifecycle

`packages/admin-core/src/ops/chat/`:

```
ops/chat/sessions.ts        → chat.list_sessions, chat.create_session, chat.rename_session, chat.archive_session
ops/chat/messages.ts        → chat.list_messages, chat.send_message (begins streaming)
ops/chat/publish.ts         → chat.publish (merges chat-branch snapshots into main + clears branch pointer)
```

`chat.send_message` is the heart of the phase:
1. Validates user input.
2. Loads session, messages, site_ai_memory.
3. Constructs system prompt: site_ai_memory slots concatenated + tool definitions.
4. Streams from the provider; persists assistant text + tool_calls to `chat_messages` as they arrive.
5. For each tool call, dispatches to the tool handler with `actorKind: "ai"` and the chat's `chat_branch_id` carried through `ExecutionContext`.
6. Persists the tool result back as a `role: "tool"` message; loops until the model emits `stopReason: "end_turn"`.
7. Records `ai_calls` row with usage totals.
8. Returns the final assistant message id; the SSE stream emits intermediate text deltas all the way through.

`chat.publish` is the merge step: read every snapshot with `chat_branch_id = $1`, re-emit them as new snapshots without the branch id (using `emitSnapshot` with `chat_branch_id: null`), and set `chat_sessions.published_at`. The chat's preview branch becomes view-only after publish.

`ExecutionContext` gains a new optional field: `chatBranchId?: string`. The Adapter sets `caelo.chat_branch_id` session var; revert ops and read ops that need branch awareness consume it. The branch read path is "prefer the latest snapshot for an entity tagged with this branch id; fall back to main".

## Site AI memory

`packages/admin-core/src/ops/security/ai_memory.ts`:

```
ai_memory.list           → Owner-only; returns every slot (or empty)
ai_memory.set            → Owner-only; replaces the slot's body, snapshot included
ai_memory.propose        → AI tool — writes to site_memory_proposals
ai_memory.review         → Owner-only; accepts (calls ai_memory.set) or rejects
```

Memory composition into the system prompt is a tiny pure function in `ai/system-prompt.ts`:

```typescript
export function composeSystemPrompt(memory: SiteAiMemory[], tools: ToolDefinition[]): string
```

Owner-curated body + a tools-as-JSON catalogue. Cached by Anthropic's prompt-caching layer on the slot+tools boundary.

## Admin UI

```
/content/chat                            → New chat + sessions list (left), pinned active session
/content/chat/[sessionId]                → Active chat: composer + transcript + preview pane + publish pill
/security/ai                             → provider config (existing stub fills here): API key + model
/security/ai/memory                      → site_ai_memory editor (Owner-only)
/security/ai/memory-proposals            → review queue
/security/costs                          → fills with ai_calls aggregates (existing stub)
```

Composer features:
- "New chat" button (top-left).
- Streaming message renderer using SvelteKit's `EventSource` integration.
- Click-to-chat: preview iframe injects a hover pencil per `data-caelo-target` element. Click → `postMessage('caelo:edit-element', { selector, moduleId, label })` → composer appends a chip.
- Visual diff overlay: when an `edit_module` tool call lands a snapshot, the preview re-renders against the chat's branch and the previous state, then DOM-diffs the two. Toggle button switches to code-diff (existing P3 preview rendering with red/green text marks).
- Publish pill: bottom-right of the page, shows pending-change count with a single "Publish" button. Click triggers `chat.publish`; pill clears.
- Provider-brand absent: nowhere in the chat HTML or CSS does the string `Claude` / `Anthropic` / etc. appear. Single source of truth for the label is a `<AiAvatar />` component that hardcodes "AI".

## Tests (per CLAUDE.md §6)

**Unit:**
- `packages/shared/src/ai-tools.test.ts`: `edit_module` Zod schema enforcement; `.strict()` rejection.
- `packages/admin-core/src/ai/__tests__/system-prompt.test.ts`: composeSystemPrompt is deterministic across slot order.
- `packages/admin-core/src/ai/__tests__/provider-fixture-replay.test.ts`: a recorded Anthropic SSE stream replays through the abstraction and yields the expected ProviderEvent sequence.

**Integration (real Postgres + recorded provider fixtures):**
- `chat-send-edit-module.integration.test.ts`: send a user message → fixture provider responds with one `edit_module` tool call → handler dispatches `modules.update` → `module_snapshots` row lands tagged with the chat's `chat_branch_id` → `chat_messages` has `user`/`assistant`/`tool` rows → `ai_calls` row recorded.
- `chat-publish.integration.test.ts`: same setup, then `chat.publish` → branch snapshots re-emitted as main → live `modules` row reflects the change → `chat_sessions.published_at` set.
- `chat-branch-isolation.integration.test.ts`: two sessions edit the same module via fixture provider; reads through one session's branch see its edit; reads through the other branch don't; main is untouched until publish.
- `site-ai-memory.integration.test.ts`: Owner sets `brand-voice`; system prompt round-trip includes it; AI proposal queues into `site_memory_proposals`; Owner accepts → memory updates → snapshot emitted.
- `actor-scope-widening.integration.test.ts`: `actorKind: "ai"` calling `modules.update` succeeds; calling `pages.update` fails with `ActorScopeRejected` (other surfaces still gated).
- `ai-calls-accounting.integration.test.ts`: a streamed call records token counts + cost estimate; cost dashboard query aggregates correctly.

**Playwright E2E:**
- `chat-edit-module.browser.ts`: dev owner logs in, sets API key (or test bypasses with a fake provider that replays a fixture), opens `/content/chat`, types prompt, watches stream, sees pill, clicks Publish, sees /content/history entry attributed to AI actor.
- `chat-element-chips.browser.ts`: clicks 3 elements → 3 chips → sends prompt → 3 modules updated in one turn.
- `chat-no-provider-brand.browser.ts`: scans the chat HTML and asserts no provider-brand strings present; checks `/security/ai` does have them.
- `chat-branch-isolation.browser.ts`: two browser contexts (two editors) edit the same module via two chats → neither sees the other's pending edit until either publishes.
- `site-memory-proposal.browser.ts`: AI proposes → Owner sees the queue → accepts → memory applies on the next chat.

CI-fixture replay is a recorded JSON of the provider's SSE stream in `packages/admin-core/test-fixtures/anthropic/*.jsonl`. The real-provider tests live behind `bun run test:live` and are gated on `ANTHROPIC_API_KEY` being set; PR CI never runs them.

## Files added

```
packages/migrations/migrations/cms_admin/0011_p5_ai_chat.sql
packages/migrations/src/schema/cms_admin/site_ai_memory.ts
packages/migrations/src/schema/cms_admin/ai_providers.ts
packages/migrations/src/schema/cms_admin/chat_sessions.ts
packages/migrations/src/schema/cms_admin/chat_messages.ts
packages/migrations/src/schema/cms_admin/ai_calls.ts
packages/migrations/src/schema/cms_admin/site_memory_proposals.ts

packages/shared/src/ai-tools.ts                              # Zod schemas for tool inputs
packages/shared/src/ai-tools.test.ts

packages/admin-core/src/ai/provider.ts                       # AIProvider interface + ProviderEvent union
packages/admin-core/src/ai/providers/anthropic.ts            # Anthropic implementation
packages/admin-core/src/ai/providers/index.ts                # provider factory keyed by name
packages/admin-core/src/ai/tools/dispatch.ts                 # tool registry + dispatcher
packages/admin-core/src/ai/tools/edit-module.ts
packages/admin-core/src/ai/tools/site-memory-propose.ts
packages/admin-core/src/ai/system-prompt.ts                  # composeSystemPrompt
packages/admin-core/src/ai/__tests__/system-prompt.test.ts
packages/admin-core/src/ai/__tests__/provider-fixture-replay.test.ts
packages/admin-core/test-fixtures/anthropic/edit-module-one-shot.jsonl
packages/admin-core/test-fixtures/anthropic/site-memory-propose.jsonl

packages/admin-core/src/ops/chat/sessions.ts
packages/admin-core/src/ops/chat/messages.ts
packages/admin-core/src/ops/chat/publish.ts
packages/admin-core/src/ops/security/ai_memory.ts
packages/admin-core/src/ops/security/ai_providers.ts
packages/admin-core/src/ops/security/ai_calls.ts             # read-only aggregates for the dashboard
packages/admin-core/src/register.ts                          # register all new ops

packages/admin-core/src/__tests__/chat-send-edit-module.integration.test.ts
packages/admin-core/src/__tests__/chat-publish.integration.test.ts
packages/admin-core/src/__tests__/chat-branch-isolation.integration.test.ts
packages/admin-core/src/__tests__/site-ai-memory.integration.test.ts
packages/admin-core/src/__tests__/actor-scope-widening.integration.test.ts
packages/admin-core/src/__tests__/ai-calls-accounting.integration.test.ts

apps/admin/src/routes/content/chat/+layout.server.ts
apps/admin/src/routes/content/chat/+page.server.ts
apps/admin/src/routes/content/chat/+page.svelte
apps/admin/src/routes/content/chat/[sessionId]/+page.server.ts
apps/admin/src/routes/content/chat/[sessionId]/+page.svelte
apps/admin/src/routes/content/chat/[sessionId]/stream/+server.ts   # SSE endpoint
apps/admin/src/routes/content/chat/[sessionId]/publish/+page.server.ts
apps/admin/src/routes/security/ai/+page.server.ts                  # fills the existing stub
apps/admin/src/routes/security/ai/+page.svelte
apps/admin/src/routes/security/ai/memory/+page.server.ts
apps/admin/src/routes/security/ai/memory/+page.svelte
apps/admin/src/routes/security/ai/memory-proposals/+page.server.ts
apps/admin/src/routes/security/ai/memory-proposals/+page.svelte
apps/admin/src/routes/security/costs/+page.server.ts                # fills the existing stub
apps/admin/src/routes/security/costs/+page.svelte

apps/admin/e2e/chat-edit-module.browser.ts
apps/admin/e2e/chat-element-chips.browser.ts
apps/admin/e2e/chat-no-provider-brand.browser.ts
apps/admin/e2e/chat-branch-isolation.browser.ts
apps/admin/e2e/site-memory-proposal.browser.ts
```

## Audit + RLS coverage matrix

| Op | Permission | Audit `entity_id` | Snapshot emitted? |
|---|---|---|---|
| chat.list_sessions | content.read | null | no |
| chat.create_session | content.read | session id | no (chat machinery, not content) |
| chat.send_message | content.read (read transcript) + downstream tool perms | message id | yes (per tool call inside) |
| chat.publish | content.write | session id | yes (re-emits branch snapshots) |
| chat.archive_session | content.read | session id | no |
| ai_memory.list | settings.read | null | no |
| ai_memory.set | settings.write | slot | yes (memory snapshot) |
| ai_memory.propose | content.write (AI in-scope) | proposal id | no (queue only) |
| ai_memory.review | settings.write | proposal id | yes when accepting |
| ai_providers.set | settings.write | provider id | no (config, not content) |
| ai_calls.aggregate | settings.read | null | no |

Tools called by AI:
- `edit_module` → `modules.update` (existing P3 op, snapshot emitted).
- `site_memory.propose` → `ai_memory.propose` op.

## Implementation order

1. Migration + drizzle schemas. `bun run db:migrate` green.
2. `packages/shared/src/ai-tools.ts` Zod schemas + unit tests.
3. `AIProvider` interface + Anthropic implementation + fixture-replay test.
4. Tool dispatch + `edit_module` tool + `site_memory.propose` tool. `actorScope` widens on `modules.update`.
5. Chat session ops (`sessions`, `messages`, `publish`). Integration tests against fixture provider.
6. Site AI memory ops + system-prompt composer.
7. Admin routes: `/content/chat/**`, `/security/ai/**`, `/security/costs`. SSE streaming endpoint.
8. Click-to-chat preview-iframe injection (preview composer change). Visual diff overlay.
9. Cost dashboard reads from `ai_calls`.
10. Playwright flows. Full e2e green.
11. CLAUDE.md update only if a new invariant emerged (none expected — every constraint is already in §2).

Estimated effort: schema + provider abstraction + tool dispatch is ~1 week; chat session lifecycle + ephemeral branches is ~1 week; UI + click-to-chat + visual diff is ~1 week. Total ~3 weeks at the P3/P4 pace.

## Out of scope (explicit)

- Other AI providers → P16.
- Skills system + auto-engagement → P10A.
- AI translation → P10.
- Per-actor / per-op-type budget enforcement → P16.
- Plugin tools (`analyze_plugin_data`) → P12.
- Cross-page edits, page composer tools, template tools → later phases.
- Real screenshot-based visual diff → P6 with the static generator.
- Linkable chat URLs / share-a-chat → not on the roadmap.
- Auto-translation of chat history → not on the roadmap.

## Risks & mitigations

- **Ephemeral chat branches add a branch-aware read path to a lot of ops.** Risk: every existing read becomes branch-aware, doubling read complexity. Mitigation: in week 1, prototype the branch-read on `modules.get_with_branch` only and decide go/no-go. If the surface bloats, fall back to publish-on-every-tool-call (last-write-wins between chats; same shape as P3) and revisit branches in P10A.
- **Provider streaming + tool dispatch in one SSE pipeline.** Anthropic streams tokens *and* tool-call args as deltas; tool calls execute server-side; the result has to flow back into the same pipeline. Mitigation: write the fixture-replay first (no real provider), get the integration test green, only then plug in the real SDK.
- **Visual diff overlay performance.** Re-running the composer + DOM-diffing two HTML strings on every tool call could lag the editor. Mitigation: debounce 200ms; only re-render when the streaming tool call completes, not on every text delta.
- **Brand-leak through error messages.** Anthropic SDK error messages may include the string `"anthropic"`. Mitigation: catch at the provider boundary, sanitize before bubbling up to chat UI.
- **Token-cost drift.** The per-million-token price changes; hard-coded estimates rot. Mitigation: store input_tokens and output_tokens always; compute cost lazily in the dashboard from a pricing table that the Owner can edit (P5 ships with current Opus 4.7 prices; admin can override).
- **Live-API tests are flaky.** Mitigation: tests against the real provider live behind `bun run test:live` and are not in PR CI. Fixture-replay is the PR gate.

## Exit criteria

- All unit + integration + Playwright tests pass in CI.
- Manual run of the verification flow (10 steps above) produces a working AI module edit with snapshot, branch isolation, click-to-chat, and visual diff.
- `bun run typecheck`, `bun run lint`, `bun run license:check` clean.
- Phase file in `plans/phases/phase_5_ai_module_edit.md` updated to mirror this document.
- Conventional commits per logical step (schema, provider, tools, chat ops, UI, tests).
