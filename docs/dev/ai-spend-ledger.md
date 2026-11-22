# The AI spend ledger

Every paid AI call reserves its worst-case cost before it reaches the provider, and settles to its real cost afterwards (#1653). This is what makes the budgets in Settings → AI → Budgets and a plugin's AI cap actually bind, including when calls run in parallel.

Code: `packages/plugin-host/src/ai-ledger.ts` (the ledger), `packages/admin-core/src/ops/security/ai_ledger.ts` (the priced operations), `packages/admin-core/src/ai/chat-runner/turn-spend.ts` (chat turns), `packages/admin-core/src/ai/ai-spend.ts` (single-shot core calls), `packages/plugin-host/src/plugin-ai.ts` (`ctx.ai`), `packages/plugin-host/src/image-ledger.ts` (images).

## The row is the reservation

A reservation is an `ai_calls` row with `reservation = 'reserved'` and the call's worst case in `cost_estimate_microcents`. Every sum that reads `ai_calls` therefore counts calls that are still running: the budgets, the plugin cap, the cost dashboard.

| `reservation` | Meaning |
|---|---|
| `reserved` | The call runs. The row holds its worst case. A reservation that is never settled (the process died) keeps that amount and ages out of the 24-hour budgets: overstated, never under. |
| `settled` | The real tokens and cost are written. Rows from before the ledger are settled. |
| `released` | The call failed, and the failure proves the provider billed nothing. Cost 0. |

Reservations and extensions take one advisory lock (`AI_LEDGER_LOCK`), shared with images. Two calls can never both pass a cap that only one fits under.

## Who spends decides which caps apply

`ai_calls.spender` (migration 0730):

| Spender | Caps |
|---|---|
| `actor`: a person's work (chat turns, subagents, moduleize, `query_page_html`, the completeness judge) | day-global, day-per-actor, session. A subagent counts toward its parent chat's session. |
| `plugin`: a plugin's `ctx.ai` and images | The same for the person it acts for (the operator of a chat call, the author of a panel call, else the system actor), plus `plugins.ai_cost_cap_microcents`. |

A text call without a chat session skips the session budget (a plugin worker has no chat). An image call refuses instead (`requireSession`), as before.

## The worst case

`worstCaseTextMicrocents` (`@caelo-cms/shared` `ai-cost.ts`, shared with the gateway's visitor-AI ledger) bills every prompt token at the dearest input lane, every output token the request's ceiling allows, and the prompt-length card when the bound crosses its threshold. The dearest input lane is the cache write, about 1.25× input, because a cold prompt may be written to the cache in full.

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

The turn settles the row to its real totals at the end. Step usage comes from the SDK's own per-step `usage` (`ProviderStepSummary.usage`). The turn counts each run's requests against its usage reports: a request that reported none (cut off by Stop, a first-chunk timeout, a connection lost while it ran) and was not proven unbilled is carried as `unreported` into every later extension and into the settlement, at its worst case. So the retry after a timeout reserves the timed-out request and the retry together, never one request's allowance for both.

## When a failed call gives its reservation back

Missing usage is no evidence that nothing was billed: a request cut off after it went out may come after the provider read the prompt and generated. A reservation is released only when the failure proves the provider billed nothing (`plugin-host` `failureProvedUnbilled`, read from the AI SDK's error types):

- the provider answered with an error status (`APICallError`, 4xx or 5xx): it refused instead of generating;
- the SDK refused to send the request (an invalid prompt or argument, an unsupported feature);
- no connection to the provider ever opened (refused, host not found);
- a `RetryError` whose every attempt is one of these.

Every other failure keeps the worst case: an abort, a timeout, a connection reset, an error this check does not know. The rule is the same for chat turns, core helpers (`aiSpendRunner`), plugin `ctx.ai` and visitors' AI in the gateway. Spend is overstated, never under, and an over-booked reservation ages out of the rolling budgets.

## Adding a paid AI call

- A single-shot call: wrap it in `aiSpendRunner(deps, spender, { what, record }).run(target, { promptTokens, maxOutputTokens }, call, usageOf)`. Pass the output ceiling to the provider explicitly, so the reservation covers exactly what can be billed. A refusal throws `AiSpendRefusedError`; turn it into the tool's own answer.
- A plugin call goes through `ctx.ai`, never around it.
- A visitor surface is not in this ledger. Visitors' AI conversations (#1654) run in the public gateway, which has no cms_admin login, on a key and budgets of their own; the gateway keeps their ledger in cms_public (`visitor_ai_calls`) with the same pricing code (`@caelo-cms/shared` `ai-cost.ts`). See [visitor-ai.md](./visitor-ai.md).

A ledger that cannot be reached lets the call through and records it afterwards (`chat.record_ai_call`). After three misses in a row it fails closed (`shared/src/cap-failures.ts`).
