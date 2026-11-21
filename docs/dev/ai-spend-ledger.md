# The AI spend ledger

Every paid AI call reserves its worst-case cost before it reaches the provider, and settles to its real cost afterwards (#1653). This is what makes the budgets in Settings → AI → Budgets and a plugin's AI cap actually bind, including when calls run in parallel.

Code: `packages/plugin-host/src/ai-ledger.ts` (the ledger), `packages/admin-core/src/ops/security/ai_ledger.ts` (the priced operations), `packages/admin-core/src/ai/chat-runner/turn-spend.ts` (chat turns), `packages/admin-core/src/ai/ai-spend.ts` (single-shot core calls), `packages/plugin-host/src/plugin-ai.ts` (`ctx.ai`), `packages/plugin-host/src/image-ledger.ts` (images).

## The row is the reservation

A reservation is an `ai_calls` row with `reservation = 'reserved'` and the call's worst case in `cost_estimate_microcents`. Every sum that reads `ai_calls` therefore counts calls that are still running: the budgets, the plugin cap, the cost dashboard.

| `reservation` | Meaning |
|---|---|
| `reserved` | The call runs. The row holds its worst case. A reservation that is never settled (the process died) keeps that amount and ages out of the 24-hour budgets: overstated, never under. |
| `settled` | The real tokens and cost are written. Rows from before the ledger are settled. |
| `released` | The call failed before the provider billed anything. Cost 0. |

Reservations and extensions take one advisory lock (`AI_LEDGER_LOCK`), shared with images. Two calls can never both pass a cap that only one fits under.

## Who spends decides which caps apply

`ai_calls.spender` (migration 0730):

| Spender | Caps |
|---|---|
| `actor`: a person's work (chat turns, subagents, moduleize, `query_page_html`, the completeness judge) | day-global, day-per-actor, session. A subagent counts toward its parent chat's session. |
| `plugin`: a plugin's `ctx.ai` and images | The same for the person it acts for (the operator of a chat call, the author of a panel call, else the system actor), plus `plugins.ai_cost_cap_microcents`. |
| `plugin-visitor`: a plugin's visitor-facing AI (#1654) | day-global, the plugin's cap, and the visitor surface's own daily cap. The cap is required: a visitor spender with none is refused, because visitor traffic is unbounded. |

A text call without a chat session skips the session budget (a plugin worker has no chat). An image call refuses instead (`requireSession`), as before.

## The worst case

`worstCaseTextMicrocents` (`ai/call-cost.ts`) bills every prompt token at the dearest input lane, every output token the request's ceiling allows, and the prompt-length card when the bound crosses its threshold. The dearest input lane is the cache write, about 1.25× input, because a cold prompt may be written to the cache in full.

The prompt bound (`tokenBoundOf`, `promptTokenBound`):
- counts every UTF-8 byte of the request's JSON text as one token, because a byte-level BPE token is at least one byte;
- counts an image or file part at `IMAGE_TOKEN_BOUND` (5,000), not at its base64 bytes;
- adds 2,000 tokens for the provider's wrapping.

A chat turn bounds each further request by the previous request's real prompt tokens plus what the history gained since. The bound never exceeds a full count.

A model without an `ai_pricing` row runs uncounted only while no cap applies to the call. Under a cap it is refused (`AiModelUnpriced`), because a cap cannot count a cost it cannot see.

## Chat turns

A turn keeps one row. The run prologue reserves before each run's first request; the stopWhen policy extends the row before every continuation step to "what the finished requests cost, plus the next request's worst case". A refusal:
- before a request: ends the turn with a notice that names the budget and the next step (`stopReason: "cost_ceiling"`);
- between steps: stops the run cleanly, and the steps that ran stay billed.

The turn settles the row to its real totals at the end. Step usage comes from the SDK's own per-step `usage` (`ProviderStepSummary.usage`).

## Adding a paid AI call

- A single-shot call: wrap it in `aiSpendRunner(deps, spender, { what, record }).run(target, { promptTokens, maxOutputTokens }, call, usageOf)`. Pass the output ceiling to the provider explicitly, so the reservation covers exactly what can be billed. A refusal throws `AiSpendRefusedError`; turn it into the tool's own answer.
- A plugin call goes through `ctx.ai`, never around it.
- A visitor surface (#1654) reserves with `{ kind: "plugin-visitor", pluginId, actorId, dailyCapMicrocents }`, the cap read from the Owner's approved setting.

A ledger that cannot be reached lets the call through and records it afterwards (`chat.record_ai_call`). After three misses in a row it fails closed (`shared/src/cap-failures.ts`).
