# Phase 16 — Additional AI providers + cost dashboard + observability + ops runbook

**Status:** ready to execute (plan v1).
**Dependencies:** P5 (provider abstraction + chat-runner cost accounting), P11.6 (per-plugin AI cost cap + `ai_calls.plugin_id` rollup), P15 (cloud installs land first so the observability surface accounts for provider-native log sinks), P12A (analytics plugin's edge-log adapters; we wire its sibling here for AI-call analytics).

---

## Context (refreshed after P15 PR4 + P11.6 + P15.1 + P17.0 shipped)

**Where the runtime stands:**
- Single AI provider: Anthropic Claude (`claude-opus-4-7`), wired via `packages/admin-core/src/ai/provider.ts`'s `AIProvider` interface. Streaming + tool-use + token usage all flow through `runChatTurn` → `recordAiCall` → `ai_calls` rows.
- `ai_calls` carries `provider`, `model`, `input_tokens`, `output_tokens`, `cached_tokens`, `cost_estimate_microcents`, `duration_ms`, `succeeded`, `chat_session_id`, `actor_id`, **and** (post-P11.6) `plugin_id`. Cost-microcents are computed at insert time from a hardcoded per-(provider,model) pricing table inside `recordAiCall`.
- Per-chat-session cost cap (`chat_sessions.cost_cap_microcents`) enforced in `runChatTurn` BEFORE the next provider call. Per-plugin cap (`plugins.ai_cost_cap_microcents`) op exists but the plugin-host's `ctx.ai.complete()` does NOT yet check it — that's the small implementation-finishing item P11.6 left for P16.
- `/security/costs` route exists as a stub (P2.1 placeholder); shows nothing.
- Audit logging covers every Query API op (`audit_events` table) + every AI call (`ai_calls`). What's missing: **structured cross-service request tracing** (request_id correlation), **per-provider configuration UI** (currently single Anthropic key in Owner panel), **operation-type budgets** (text vs image), **incident-response runbook**, **telemetry/opt-out policy**.

**P16 ships the things that turn Caelo from "single-provider, basic-spend-cap, blind-on-incident" into a real production-multi-provider observable system.**

---

## Architectural commitments — read before code

1. **Provider abstraction stays at the existing `AIProvider` interface.** Three new concrete adapters (OpenAI, Gemini, OpenAI-compatible) implement the same `generate(opts: ChatRequest): AsyncIterable<ProviderEvent>` shape. Image-generation is a SECOND `ImageProvider` interface that lives next to the chat one, NOT a new event kind on `AIProvider` — image generation has fundamentally different semantics (one shot, returns bytes/URLs, not a token stream).

2. **Cost estimation is data, not code.** The pricing table moves out of `recordAiCall`'s hardcoded switch statement into a new `ai_pricing` table keyed by `(provider, model, operation_type)`. Operators (and Pulumi for cloud installs) update pricing without a redeploy when providers bump their rates. `recordAiCall` reads from this table at insert time.

3. **Operation-type budgets are first-class.** `ai_budgets` is the new table; rows are keyed by `(scope, operation_type)` where `scope ∈ ('session', 'day-global', 'day-per-actor')` and `operation_type ∈ ('text', 'image')`. Enforcement is two-stage: a soft warning at 80% (chat-runner surfaces in the next message), hard block at 100% (next provider call fails with a structured error). **Text and image budgets are independent** — exhausting the image budget never blocks text generation.

4. **Structured logs ride alongside `audit_events`, never replacing it.** Every Caelo service emits JSON-per-line structured logs with a stable `request_id` that propagates through cookies → Query API ops → AI calls → audit rows → outgoing provider calls. The log shape is the same across admin, gateway, orchestrator, plugin-host, and static-generator. Operators ship to whatever aggregator they want; the spec is "fields exist + are stable", not "we run a log indexer."

5. **Telemetry is off-by-default + opt-in only.** No install pings. No anonymized error reports unless the Owner explicitly enables. Documented in `docs/TELEMETRY.md` BEFORE any default-on telemetry slips into a component. MPL-2.0 community trust hygiene.

---

## What ships

### 1. Three new AI providers (`packages/admin-core/src/ai/providers/`)

#### 1a. `openai.ts` — OpenAI text + DALL·E images

OpenAI text uses `chat.completions` (streaming with tool-use). Pin `openai@^5` (verify latest via context7 before adding). Adapter shape:

```ts
export const openAiTextProvider: AIProvider = {
  name: "openai",
  async *generate(opts) {
    const client = new OpenAI({ apiKey: opts.apiKey });
    const stream = await client.chat.completions.create({
      model: opts.model,
      messages: convertToOpenAi(opts.messages, opts.systemPrompt),
      tools: convertToOpenAiTools(opts.tools),
      stream: true,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    });
    for await (const chunk of stream) {
      // map chunk → ProviderEvent (text-delta | tool-use | usage | error)
    }
  },
};
```

Streaming protocol differences from Anthropic: OpenAI emits delta tool-use args incrementally (need accumulator); usage reports come with the final chunk only when `stream_options: { include_usage: true }` is set. Adapter handles both.

DALL·E (`dall-e-3`) uses `images.generate`. Different surface — single-shot, returns image URLs (or b64). Wrapped in a separate `ImageProvider`:

```ts
export interface ImageProvider {
  readonly name: string;
  generate(opts: ImageRequest): Promise<ImageResponse>;
}

export interface ImageRequest {
  readonly prompt: string;
  readonly model: string;
  readonly size: "1024x1024" | "1792x1024" | "1024x1792";
  readonly quality?: "standard" | "hd";
  readonly apiKey: string;
}

export interface ImageResponse {
  readonly imageUrl: string; // ephemeral OpenAI/Gemini URL
  readonly revisedPrompt: string | null;
  readonly costMicrocents: number; // computed from `ai_pricing` lookup at adapter level
  readonly durationMs: number;
}
```

The chat-runner doesn't dispatch image generation; instead, an AI tool `generate_image({prompt, size?})` (registered under tool guidance "use to create on-brand product/marketing imagery") calls a new `ai.generate_image` op which calls the configured `ImageProvider`. Generated images persist via the existing `media.upload_object` op + AI receives the resulting `media_id` in the tool result.

#### 1b. `gemini.ts` — Google Gemini text + Imagen images

Gemini text via `@google/generative-ai`. Tool-use as `functionDeclarations`. Streaming via `generateContentStream`. Imagen via `generateImages` (Vertex AI; requires GCP project credentials). Same `AIProvider` + `ImageProvider` shapes; pinned to `@google/generative-ai@^0.24` (verify).

#### 1c. `openai-compatible.ts` — Ollama / LM Studio / LocalAI / vLLM via OpenAI-compatible API

A single adapter that takes a `baseUrl` (and optional `apiKey`) and reuses the OpenAI client pointed at that URL:

```ts
export function makeOpenAiCompatibleProvider(opts: {
  name: string;       // "ollama-llama3.1", "lm-studio-qwen-coder", etc.
  baseUrl: string;    // http://localhost:11434/v1 (Ollama default)
  apiKey?: string;    // empty for local; set for vLLM-with-token deployments
}): AIProvider;
```

Same streaming protocol as OpenAI — the OpenAI SDK already supports `baseURL` override. Local providers don't track usage in the standard chunk; adapter falls back to a token-counting heuristic (whitespace-split + 4-chars-per-token approximation) when usage isn't reported. Cost is zero for local models (logged for parity but `cost_estimate_microcents = 0`).

### 2. New schema (migration 0048)

```sql
-- 0048_p16_ai_providers_observability.sql

-- Per-(provider, model, operation_type) pricing. Operators update via
-- /security/ai/pricing without a redeploy when providers bump rates.
CREATE TABLE IF NOT EXISTS ai_pricing (
  provider             text NOT NULL,
  model                text NOT NULL,
  operation_type       text NOT NULL CHECK (operation_type IN ('text', 'image')),
  -- Microcents per 1K input tokens (text) OR microcents per image (image).
  input_microcents     bigint NOT NULL,
  -- Microcents per 1K output tokens. NULL for image (single-cost shape).
  output_microcents    bigint NULL,
  -- Microcents per 1K cached tokens (Anthropic prompt-cache reads).
  cached_microcents    bigint NULL,
  effective_from       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, operation_type, effective_from)
);

-- Provider configuration. One row per active provider; Owner picks
-- which is the "primary" via security/ai. AI calls dispatched via the
-- primary unless an op explicitly overrides (e.g. translation jobs may
-- pin to a specific provider for consistency).
CREATE TABLE IF NOT EXISTS ai_provider_configs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "anthropic" | "openai" | "gemini" | "openai-compatible"
  kind                 text NOT NULL,
  -- Display name (e.g. "Anthropic prod", "Ollama local"). Surfaced
  -- only in Owner UI; never in the editor chat.
  display_name         text NOT NULL,
  -- Plain string for openai/anthropic/gemini; reference path for
  -- secrets-manager-backed installs (e.g. "secret://caelo-anthropic-key").
  api_key_ref          text NOT NULL,
  -- Model identifier ("claude-opus-4-7", "gpt-4o", "gemini-1.5-pro",
  -- "llama3.1:70b" for local). Owner-editable.
  model                text NOT NULL,
  -- Optional override for openai-compatible (e.g. http://localhost:11434/v1).
  base_url             text NULL,
  -- Image-capable models declare which one to use for `generate_image`.
  image_model          text NULL,
  is_primary           boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- At most one primary at a time; partial unique enforces.
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_configs_one_primary
  ON ai_provider_configs (is_primary) WHERE is_primary = true;

-- Operation-type budgets. Three scopes × 2 op-types = 6 rows max
-- (most installs use day-global only).
CREATE TABLE IF NOT EXISTS ai_budgets (
  scope                text NOT NULL CHECK (scope IN ('session', 'day-global', 'day-per-actor')),
  operation_type       text NOT NULL CHECK (operation_type IN ('text', 'image')),
  cap_microcents       bigint NULL,
  -- Soft-warn at this fraction of cap (default 0.8). Chat-runner emits
  -- a one-line `cost-warning` event when crossed; hard-blocks at 1.0.
  warn_at_pct          numeric(3,2) NOT NULL DEFAULT 0.80,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, operation_type)
);

-- ai_calls extension — operation_type so the dashboard can split text
-- vs image series. Default 'text' so all existing rows backfill cleanly.
ALTER TABLE ai_calls
  ADD COLUMN IF NOT EXISTS operation_type text NOT NULL DEFAULT 'text'
    CHECK (operation_type IN ('text', 'image')),
  -- For images, output_tokens is overloaded as "image count" (1 row per image).
  ADD COLUMN IF NOT EXISTS image_count int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ai_calls_op_type_idx
  ON ai_calls (operation_type, created_at DESC);

-- All four new tables get FORCE RLS with the standard authenticated_scope
-- policy + WITH CHECK = system on writes (operator-only configuration).
```

Seeded `ai_pricing` rows for all three new providers (Anthropic already-seeded effectively-via-code; the migration moves it to data):

| provider | model | operation_type | input_microcents | output_microcents | cached_microcents |
|---|---|---|---|---|---|
| anthropic | claude-opus-4-7 | text | 1500000 (×1e-8 = $15/1M) | 7500000 ($75/1M) | 150000 ($1.50/1M cached) |
| openai | gpt-4o | text | 250000 ($2.50/1M) | 1000000 ($10/1M) | 125000 |
| openai | dall-e-3 | image | 4000000 ($0.04/img standard 1024×1024) | NULL | NULL |
| gemini | gemini-1.5-pro | text | 350000 | 1050000 | 87500 |
| gemini | imagen-3.0-generate-001 | image | 4000000 | NULL | NULL |
| openai-compatible | * | text | 0 | 0 | 0 |

(Pricing is illustrative — actual at-deploy values pulled via context7 lookup before the migration ships.)

### 3. New ops + AI tools

**Ops** (`packages/admin-core/src/ops/security/ai_providers.ts` already exists for the legacy single-provider config; this expands it):

- `ai_providers.list` — open read; returns all configured providers + which is primary.
- `ai_providers.create` / `update` / `delete` — Owner-only.
- `ai_providers.set_primary` — Owner-only; flips `is_primary` to one row, clears all others (transactional).
- `ai_pricing.list` / `set` — Owner-only on writes; open read so the AI can answer "what does a Mode 2 translation cost on Gemini?".
- `ai_budgets.list` / `set` — Owner-only on writes; open read.
- `ai_calls.aggregate` — extended to accept `operationType?: 'text' | 'image'` filter + `groupBy: 'provider' | 'model' | 'actor' | 'plugin' | 'operation_type'`.
- `ai_calls.budget_status` — new; returns each `(scope, operation_type)` budget's current spend + cap + percent + status (`ok`/`warn`/`blocked`). Open read; chat-runner consults before every provider call.

**AI tool**: `generate_image({prompt, size?, quality?})` — calls the primary provider's image endpoint, persists via `media.upload_object`, returns `{mediaId, mediaUrl, revisedPrompt}`. Tool description:

> *"Generate an image from a natural-language prompt. Use for marketing visuals, product mockups, hero illustrations. Output is uploaded to media; the returned `mediaId` is suitable for `add_module_to_page` HTML referencing `<img src='/media/<id>'>`. NOTE: image generation has its own daily budget separate from text — if the budget is exhausted you'll get a structured error. Verify the prompt is on-brand before calling; image generation is rarely cheap."*

Tool actorScope `human + ai`. Per-image cost lands in `ai_calls.cost_estimate_microcents` with `operation_type='image'` + `image_count=1`.

### 4. Cost dashboard at `/security/costs` (real, not stub)

Five panels:

1. **Today + this month at a glance** — totals (calls, tokens, cost USD) split into text + image rows. Color-coded budget cells: green <80%, amber 80-99%, red ≥100%.
2. **Spend over time** — stacked area chart (uses chart-svelte or a hand-rolled SVG; adds zero new deps if we extend an existing chart component). Series: text-by-provider + image-by-provider. 60-day window default; selectable 7d/30d/90d/all.
3. **Per-provider breakdown** — table (provider, model, calls, input tok, output tok, cached tok, cost USD, % of total).
4. **Per-actor breakdown** — table (actor display name + kind: ai/human/plugin, calls, cost USD, % of total). Click an actor row → drill-down to per-session list (re-uses the chat history surface).
5. **Per-plugin breakdown** — table (plugin slug, calls, cost USD, cap %, last 24h, all-time). Click a plugin row → `/security/plugins/<slug>`.

Plus an **operator-action strip** at the top:
- "Provider configurations" → `/security/ai/providers`
- "Pricing" → `/security/ai/pricing`
- "Budgets" → `/security/ai/budgets`
- "Export CSV" → downloads the last-90-days `ai_calls` rows as CSV (operator records).

### 5. Provider configuration UI (`/security/ai/providers`)

Table of configured providers with: kind, display name, model, image model (if any), is_primary, last-call timestamp, last-24h spend. Actions: add (modal with provider-kind picker → form), edit, delete, set-primary. Editing the API key shows masked (`sk-…last4`) + a "rotate" affordance that prompts for the new key.

### 6. Pricing UI (`/security/ai/pricing`)

Table of (provider, model, operation_type) → microcents columns. Owner edits inline; new (provider, model, op-type) row insert form below. Effective-from defaults to `now()`; historical rows kept so cost calculations on old `ai_calls` rows stay accurate when pricing changes.

### 7. Budgets UI (`/security/ai/budgets`)

Form with the six budget rows (3 scopes × 2 op-types) — operator sets cap (USD, converted to microcents) + warn-at-pct. Below each row: current spend + percent (live, polled every 5s while page is open).

### 8. Structured logging across all services

New shared module `packages/shared/src/logger.ts`:

```ts
export interface LogContext {
  readonly requestId: string;
  readonly actorId?: string;
  readonly actorKind?: "human" | "ai" | "system" | "plugin";
  readonly opName?: string;
  readonly chatSessionId?: string;
  readonly pluginSlug?: string;
}

export interface StructuredLogEntry {
  readonly ts: string;        // ISO timestamp
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly service: "admin" | "gateway" | "orchestrator" | "plugin-host" | "static-gen";
  readonly env: "dev" | "staging" | "production";
  readonly ctx: LogContext;
  readonly extra?: Record<string, unknown>;
}

export function makeLogger(service: StructuredLogEntry["service"]): {
  with(ctx: Partial<LogContext>): Logger;
  info(msg: string, extra?: Record<string, unknown>): void;
  // ... warn / error / debug
};
```

Every entry written as one JSON line to `process.stderr`. Production deployments pipe stderr to whatever aggregator the operator runs (Loki/Datadog/CloudWatch/etc.); dev install just sees the JSON in the terminal.

`request_id` is generated at the request boundary (SvelteKit hooks `handle` for admin, gateway request handler, orchestrator tick start, plugin-host operation start). Propagated via:
- `ExecutionContext.requestId` (existing field) for in-process flow,
- `X-Caelo-Request-Id` header for any service-to-service HTTP call,
- `audit_events.request_id` (new column in 0048) for cross-correlation between logs + audit.

Adds `request_id` to `audit_events` + `ai_calls` so a single request_id query returns the full timeline.

### 9. Incident-response runbook (`docs/incident-response.md`)

Real ops doc. Sections:

- **Triage decision tree** — admin down, deploy stuck, AI calls failing, plugin sandbox crashing, etc.
- **Log-correlation queries per provider** (self-hosted: `journalctl -u caelo-admin | jq 'select(.ctx.requestId == "...")'`; AWS: CloudWatch insights query; GCP: Logs Explorer query; Azure: KQL on Log Analytics).
- **Escalation pathways** — when to roll back vs. when to ride out.
- **Postmortem template** — copy-paste markdown for after-action.
- **Common-issue runbook entries** — pre-written: "auth_config corrupted", "plugin crashed entire host", "RDS Multi-AZ failover happened", "edge-router returning 500s after deploy".

Lives in `docs/` so OSS contributors can submit additional entries via PR.

### 10. Telemetry / opt-out policy (`docs/TELEMETRY.md`)

Short doc, pre-launch decision:

- **Default state: completely off.** Caelo phones home for nothing.
- **Opt-in install ping** (Owner-toggleable in `/security/telemetry`): one POST per install per week with `{caelo_version, provider, anonymized_install_id}`. Used for "how widely is Caelo deployed?" stats only. No PII, no AI usage data, no error reports.
- **Opt-in error reporting** (separate toggle): structured-log `error`-level entries only, no payloads, no headers, no SQL. Sent to a public-facing GitHub Issues sink (operator can review the mapping at `docs/TELEMETRY.md#error-categories` before opting in).
- **Never collected**: chat content, AI prompts, plugin data, visitor PII, any DB row.
- **Owner UI** (`/security/telemetry`): shows what's currently sent, a toggle per category, a "test send" that prints the payload locally without actually sending.
- **MPL-2.0 community trust**: this doc is part of the OSS launch checklist; reviewers explicitly check the "off by default" claim against the code.

### 11. Per-plugin AI cost cap enforcement (P11.6 finishing item)

Plugin-host's `ctx.ai.complete()` already mints an `ai_call` row with `plugin_id` populated. P16 wires the pre-flight check: before dispatching to the provider, call `ai_calls.aggregate_per_plugin({pluginId})` (which P11.6 shipped). If `capExceeded === true`, return a structured error from `ctx.ai.complete()` instead of dispatching:

```ts
return {
  ok: false,
  error: { kind: "PluginAiCapExceeded", pluginSlug: <slug>, capUsd: <cap>, spentUsd: <spent> },
};
```

Plugin's operation surfaces the error; Owner sees it in `/security/plugins/<slug>` + chat surface. AI tool descriptions document the failure mode.

### 12. Audit log enrichment

`audit_events` already has actor_id + operation + succeeded + input_hash (sensitive fields redacted). P16 adds:
- `request_id text NULL` (correlation with structured logs).
- `provider text NULL` + `model text NULL` (only set when `operation = 'ai_calls.*'` or AI tool dispatch).
- `operation_type text NULL CHECK (operation_type IN ('text','image'))` — same column shape as `ai_calls`.

The dashboard's CSV export pulls from `audit_events` joined with `ai_calls` for the unified timeline.

---

## Composition rules + safety

1. **Provider switch is atomic.** `ai_providers.set_primary` runs in a single transaction; the `ai_provider_configs_one_primary` partial unique index makes "two primaries" structurally impossible.

2. **Pricing changes don't retroactively re-cost old rows.** `ai_calls.cost_estimate_microcents` is computed at insert time + persisted. If pricing changes mid-month, the dashboard's totals stay accurate to what was charged when the call happened; new calls use the new pricing.

3. **Budget enforcement consults the latest cap.** Pre-flight checks query `ai_budgets` afresh (no caching). A mid-day budget bump takes effect on the next call.

4. **Image generation is opt-in per provider.** A provider config without `image_model` set means `generate_image` AI tool is unavailable when that provider is primary. AI sees the tool absence in its catalogue + can answer "image generation is not configured on the active provider."

5. **Local providers (`openai-compatible`) carry zero cost for budget purposes.** Self-hosted Ollama isn't free (electricity + GPU) but the operator chose to run it; Caelo doesn't second-guess.

6. **Telemetry payloads are content-addressed.** Even error-reporting opt-in only sends a sha256 of the redacted message + a category enum, NOT the message itself. Operators reviewing what would be sent see a deterministic preview.

7. **Structured logs never contain secrets.** Logger has a redaction pass that replaces values for keys matching `/(password|secret|token|key|cookie)/i` with `***`. Test asserts.

8. **The `request_id` propagates across service boundaries explicitly.** Plugin host → admin: header. Orchestrator tick → admin op call: ExecutionContext field. Static-gen → admin: env var. Any service whose handler runs without a `request_id` mints one + logs it as `synthetic` so downstream correlation surfaces the gap.

---

## Critical files

**New (admin-core):**
- `packages/admin-core/src/ai/providers/openai.ts` — OpenAI text + DALL·E adapters.
- `packages/admin-core/src/ai/providers/gemini.ts` — Gemini text + Imagen adapters.
- `packages/admin-core/src/ai/providers/openai-compatible.ts` — Ollama / LM Studio / vLLM / LocalAI shared adapter.
- `packages/admin-core/src/ai/image-provider.ts` — `ImageProvider` interface + dispatch.
- `packages/admin-core/src/ai/tools/generate-image.ts` — AI tool.
- `packages/admin-core/src/ops/security/ai_providers.ts` — extended with `set_primary` + image_model fields.
- `packages/admin-core/src/ops/security/ai_pricing.ts` — list / set ops.
- `packages/admin-core/src/ops/security/ai_budgets.ts` — list / set / status ops.
- `packages/admin-core/src/ops/security/ai_calls.ts` — extend with `operationType` filter + `groupBy`.

**New (shared):**
- `packages/shared/src/logger.ts` — `makeLogger`, `LogContext`, redaction pass.

**New (admin UI):**
- `apps/admin/src/routes/(authed)/security/costs/+page.{svelte,server}.ts` — five-panel dashboard (replaces stub).
- `apps/admin/src/routes/(authed)/security/ai/providers/+page.{svelte,server}.ts` — provider list + add/edit/delete/set-primary.
- `apps/admin/src/routes/(authed)/security/ai/pricing/+page.{svelte,server}.ts` — pricing table.
- `apps/admin/src/routes/(authed)/security/ai/budgets/+page.{svelte,server}.ts` — budgets form + live spend.
- `apps/admin/src/routes/(authed)/security/telemetry/+page.{svelte,server}.ts` — opt-in toggles + payload preview.
- `apps/admin/src/routes/(authed)/security/+page.svelte` — add tiles for AI providers / pricing / budgets / telemetry.

**New (docs):**
- `docs/incident-response.md` — operator runbook.
- `docs/TELEMETRY.md` — telemetry policy.

**Modified:**
- `packages/migrations/migrations/cms_admin/0048_p16_ai_providers_observability.sql` — schema above.
- `packages/admin-core/src/ai/provider.ts` — keep `AIProvider` interface; add provider-kind discriminator.
- `packages/admin-core/src/ai/recordAiCall.ts` — read pricing from `ai_pricing` table instead of hardcoded switch.
- `packages/admin-core/src/ai/chat-runner.ts` — pre-flight `ai_calls.budget_status` check; soft-warn + hard-block paths; emit `cost-warning` ClientEvent.
- `packages/plugin-host/src/capabilities.ts` — wire per-plugin cap pre-flight check in `ctx.ai.complete()` (the P11.6 finishing item).
- `apps/admin/src/hooks.server.ts` — generate `request_id` per request, thread into `ExecutionContext`, mount logger.
- `apps/api-gateway/src/server.ts` — same request_id pattern.
- `packages/redeploy-orchestrator/src/index.ts` — request_id per tick.
- `packages/admin-core/src/audit.ts` — extend `recordAudit` to write `request_id` + AI provenance fields.
- `packages/admin-core/src/register.ts` — register new ops.
- `packages/admin-core/src/ai/tools/index.ts` — register `generate_image` tool.

---

## Verification

End-to-end after the PR lands:

1. **`bun run typecheck && bun test && bun run lint && bun run license:check`** — clean. New deps `openai`, `@google/generative-ai` confirmed Apache-2.0/MIT.
2. **Provider-switch round-trip**: Owner adds OpenAI provider config in `/security/ai/providers`, sets primary, asks the editor chat to "make the hero blue" → AI uses OpenAI under the hood; provider brand never surfaces in editor chat (CLAUDE.md §2 invariant); `ai_calls` row carries `provider='openai'`, `model='gpt-4o'`.
3. **Three new providers all stream + tool-use**: smoke-test with each (Anthropic / OpenAI / Gemini / OpenAI-compatible against local Ollama). Each round-trips a one-tool conversation (`set_page_title`) end-to-end.
4. **Image generation end-to-end**: AI calls `generate_image({prompt: "blueprint of a sunset"})` → DALL·E returns a URL → media.upload_object pulls bytes → returns mediaId → AI uses in `add_module_to_page`. `ai_calls` row has `operation_type='image'`, `image_count=1`, cost matches pricing table.
5. **Budgets enforce independently**: set image cap to $0.05/day → run two `generate_image` calls → second one returns structured `ImageBudgetExceeded` error → text generation continues working in the SAME chat session.
6. **Per-plugin cap enforces (P11.6 finish)**: set translation plugin's `ai_cost_cap_microcents = 100`, run a Mode-1 translation that would exceed it → second invocation returns `PluginAiCapExceeded` error visible in the translation dashboard.
7. **Cost dashboard accuracy**: trigger 5 chat sessions across 3 providers + 1 image gen; `/security/costs` totals match SUM(`cost_estimate_microcents`) per group; CSV export has every row.
8. **Pricing change doesn't backdate**: bump anthropic claude-opus-4-7 input price → existing `ai_calls` rows unchanged in cost; new call uses new pricing.
9. **Structured logs correlate**: tail admin + gateway + orchestrator stderr; trigger one editor chat that AI-edits a module + triggers a deploy; grep stderr by request_id → see the whole chain (admin login + chat-runner + provider call + recordAuditEvent + plugin tool dispatch + redeploy orchestrator tick that fires deploy.trigger). Same request_id lands in `audit_events.request_id` for the same rows.
10. **Logger redaction**: write a log entry with `{password: "secret123"}` extra → output replaces value with `***`. Test asserts.
11. **Incident-response runbook smoke**: an operator follows `docs/incident-response.md` triage tree for a fake "admin returns 500" incident; queries surface the right rows in <2 min.
12. **Telemetry off-by-default**: fresh install → `/security/telemetry` shows all toggles off + a "0 events sent" counter; toggling install-ping on + clicking "test send" prints the payload locally without an outbound HTTP call (real send only when toggled on AND in production).

---

## Deferred (intentionally NOT in this PR)

- **AI cost forecasting** — predicted month-end spend based on trailing 7-day rate. Useful but better as a P16 review-pass once we have telemetry from real deployments to know which forecasting model fits.
- **Per-experiment AI cost attribution** — costs incurred during an A/B variant's authoring don't yet roll up to the experiment row. Lands when P12A's experiment dashboard adds a "costs" tab.
- **Image-edit + variations** (DALL·E `images.edit` + `images.variations`). v1 ships text-to-image only; variation generation is uncommon and adds another tool.
- **Caching layer for redundant prompts** (Anthropic's prompt-cache is already wired via the SDK; OpenAI lacks an equivalent). A semantic-similarity cache would save real money but is its own project.
- **Per-locale provider routing** — "always use Gemini for German because of pricing." Solvable via the future translation_jobs `provider_override` (P10 deferred); P16 doesn't introduce locale-aware routing.
- **Streaming image generation** (no provider supports it natively for images yet).
- **Marketplace-style "swap your provider" wizard** — not v1; operators handle config directly.
- **Cost alerting via email/webhook** when budgets cross thresholds. Notification bell (P6.6) surfaces in-app; external alerting lands as a P16 review-pass once we know operators want it.

---

## Open questions to resolve before code starts

1. **OpenAI tool-use streaming protocol stability.** The `tool_calls` delta format is documented but version-skewed across SDK releases. v1 plan: pin `openai@^5.x` + write the adapter against the documented streaming protocol; if a future version breaks, a one-month grace window in the version-pin policy applies.

2. **Gemini's tool-call shape diff from OpenAI's.** Gemini uses `functionDeclarations` not `tools`; arg encoding is JSON not stringified-JSON. Adapter handles the conversion at the boundary; chat-runner stays provider-agnostic.

3. **Local-provider token estimation accuracy.** Whitespace-split + 4-chars-per-token is a known under-estimator (~15% low for English, ~30% low for code-heavy). Acceptable for v1 since the cost is zero anyway; if budgets ever apply to local providers, swap in a real BPE encoder (`gpt-tokenizer` MIT-licensed is a candidate).

4. **`request_id` propagation across the static-generator subprocess.** Static-gen runs as a child process spawned by the deploy op. v1 plan: the parent passes `CAELO_REQUEST_ID` env var; the child's logger picks it up. Cross-process correlation works via env, not via headers.

5. **Where do error-reporting telemetry payloads land?** v1 plan: a public-facing GitHub Issues bot at `github.com/caelo-cms/telemetry-errors`. Anyone can read what's been reported (transparency); contributors can suggest detection rules. Alternative: a hosted endpoint at telemetry.caelo-cms.com — adds a service to maintain. GitHub Issues bot is the cheaper, more-transparent choice.

---

## Effort + sequencing

**Effort: ~28 hr.** Three PRs in one milestone:

**PR 1 — Provider abstraction + 3 new providers (~12 hr).**
1. Migration 0048 schema (~2 hr).
2. `ai_providers.*` ops + UI (~3 hr).
3. OpenAI adapter (text + DALL·E) (~2 hr).
4. Gemini adapter (text + Imagen) (~2 hr).
5. OpenAI-compatible adapter (~1.5 hr).
6. `generate_image` AI tool + image-provider dispatch (~1.5 hr).

**PR 2 — Cost + budgets dashboard + per-plugin cap finish (~10 hr).**
1. `ai_pricing.*` + `ai_budgets.*` ops + UI (~3 hr).
2. `recordAiCall` reads from pricing table (~1 hr).
3. Pre-flight budget check in chat-runner + per-plugin cap enforcement in plugin-host (~2 hr).
4. Cost dashboard five-panel rewrite (~3 hr).
5. CSV export endpoint (~1 hr).

**PR 3 — Observability + ops runbook + telemetry policy (~6 hr).**
1. `packages/shared/src/logger.ts` + redaction (~2 hr).
2. `request_id` propagation in admin / gateway / orchestrator / plugin-host / static-gen (~2 hr).
3. `audit_events` + `ai_calls` schema extension for request_id + AI provenance (already in 0048).
4. `docs/incident-response.md` + `docs/TELEMETRY.md` (~1.5 hr).
5. Telemetry UI at `/security/telemetry` with toggles + test-send (~30 min).

---

## Recommendation

Ship as three sequential PRs over one milestone window. PR 1 is the load-bearing piece (provider abstraction + image generation); PR 2 makes the spend dashboard + cap enforcement real (closes the P11.6 finishing item along the way); PR 3 turns the whole system into something an operator can run incidents on.

The biggest risk is **provider-API drift**. OpenAI's tool-use streaming protocol has had two breaking iterations in the past 18 months; Gemini's function-calling shape changed in 0.21 → 0.24. Mitigation: each adapter file ships a per-provider integration test using `FixtureProvider`-style recorded responses, so a future SDK version that breaks our adapter surfaces immediately in CI.

Second risk: **cost-dashboard performance at scale.** The 60-day stacked-area query joins `ai_calls` × `ai_pricing` × `actors` × `plugins` and could be slow on installs with millions of rows. Mitigation: ship a daily-rollup table (`ai_call_daily_aggregates`) populated by the existing redeploy-orchestrator's gcSweep tick; the dashboard reads from the rollup, falling back to live for <24h windows. If telemetry shows the live query is fine, we don't need the rollup.

Third risk: **telemetry being silently default-on**. We've documented "off by default" three times now; the implementation MUST verify with a fresh install + a packet capture showing zero outbound HTTP from the install before P17 ships. Cheap to verify, expensive to recover trust from if missed.
