# Phase 16 — Additional AI providers + cost dashboard + observability

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P5.

## Goal (from master plan)
Wire remaining providers behind the P5 abstraction: OpenAI + DALL-E, Gemini + Imagen, Ollama / LM Studio / LocalAI / vLLM via the OpenAI-compatible adapter (text + images where supported). AI usage dashboard (tokens + estimated cost per provider over time). **Operation-type limits — separate budgets for text vs image generation** (requirements §17.3) — each with per-session token/image budget and daily spend cap. Structured audit log for all AI actions + Query API operations.

## End-to-end verification
Switch provider in control panel → same AI capability works; daily spend cap blocks further calls at threshold; **image-generation cap blocks image calls independently of text calls (text keeps working when image cap is exhausted, and vice versa)**.

## To be detailed before execution
- OpenAI + Gemini SDK versions (verify current). DALL-E + Imagen image generation paths.
- OpenAI-compatible adapter: single code path serves Ollama / LM Studio / LocalAI / vLLM via `baseUrl` swap.
- Cost estimation table per provider/model/**operation_type** (`text` | `image`), stored and updateable without redeploy.
- **Budget model:** `ai_budgets` table keyed by (scope, operation_type) where scope ∈ (`session`, `day-global`, `day-per-actor`); enforcement reads the matching row.
- Dashboard: token-by-provider chart, cost-over-time chart, **separate text vs image series**, per-actor breakdown.
- Budget enforcement: pre-flight check before every AI call consults the operation-type-specific budget; soft warning at 80%, hard block at 100%. Image generation failures do not block pending text calls.
- Audit log: `audit_events` table with actor, action, entity, Query API op, AI provider, operation_type, tokens (or image count), timestamp, snapshot_id (when applicable).
- Structured log export: JSON-per-line, shippable to any log aggregator.
