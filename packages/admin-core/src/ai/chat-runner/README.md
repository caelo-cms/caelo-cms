<!-- SPDX-License-Identifier: MPL-2.0 -->

# `chat-runner/`

`runChatTurn` orchestrates a single user→AI turn: persist the user message,
build the system prompt + tool catalogue, then loop (stream provider → persist
assistant text/tool_calls → dispatch tools) until the model stops, and record
one `ai_calls` row. It was split out of the former 2068-LOC
`../chat-runner.ts` monolith (issue #15) so each concern is reviewable on its
own. `../chat-runner.ts` is now a thin `export *` re-export shim onto this
directory, so every existing import path keeps resolving.

## Module map

| Module | Concern |
|---|---|
| `index.ts` | Orchestrator (`runChatTurn`) + public re-exports (`runChatTurn`, `isLegitimateTextOnlyTurn`, `ClientEvent`, `ChatRunnerOptions`). |
| `loop.ts` | The tool loop (`runToolLoop`): pre-flight history compaction → stream → persist assistant → passive-turn recovery → dispatch, plus the `max_loops` cap notice and the issue-#261 prompt-too-long compact+retry. |
| `streaming.ts` | `streamProviderTurn`: consumes one `provider.generate(...)` stream, relays text/thinking deltas, accumulates tool calls, tracks usage + soft cost cap + stop diagnostics. |
| `tool-catalogue.ts` | `buildToolCatalogue`: skill-allowlist intersection (with the issue-#106 zero-match fallback), subagent exclusion, Tier-1 plugin-tool folding. |
| `tool-dispatch.ts` | `dispatchToolCall`: dedup cache lookup, plugin-vs-builtin routing, live subagent-event streaming, auto-recovery, result caching, multimodal image append. |
| `context-blocks.ts` | `buildSystemContextBlocks`: orchestrates the `context/*` builders into the pre-catalogue block set + skill-engagement results. |
| `context/page.ts` | Current-page + all-pages blocks. |
| `context/catalog.ts` | Theme, structured sets, modules (+ usage signal), content library, media blocks. |
| `context/site.ts` | Layouts, site defaults, site identity blocks (+ raw values for `buildToolDescribeState`). |
| `context/domains.ts` | Redirects, locales, pending proposals, users, roles, AI providers, domains blocks. |
| `context/skills.ts` | Skill engagement + allowlist resolution; the post-catalogue blocks (subagents, plugin submissions, plugin promptContext). |
| `compaction.ts` | issue-#261 pure history compaction: size estimator (chars/4 heuristic), two-stage compactor (truncate old tool results, then digest the oldest span), prompt-too-long error detection. `loop.ts` compacts pre-flight over a threshold and retries ONCE on a live provider context-overflow rejection. |
| `persistence.ts` | `chat.*` / `ai_memory.*` wrappers: load memory/session, persist user/assistant turns, mark interrupted, record the `ai_calls` row. |
| `limits.ts` | Cost/token constants + `microcents` / cost helpers. |
| `passive-turn.ts` | issue-#106 guards: the nudge constant, `isLegitimateTextOnlyTurn`, loop-0 diagnostics, the nudge predicate. |
| `types.ts` | Shared types (`ClientEvent`, `ChatRunnerOptions`, `StopReason`, `ToolDispatchResult`, `StoppingDiagnostics`, `AccumulatedToolCall`, `RunChatTurnFn`). |

## Orchestration order (`runChatTurn`)

1. `persistUserMessage` → `loadMemory` + `loadSession` (`persistence.ts`).
2. `buildSystemContextBlocks` → pre-catalogue blocks + skill engagement (`context-blocks.ts` → `context/*`).
3. `buildToolDescribeState` (sibling `../tools/`) → `buildToolCatalogue` (`tool-catalogue.ts`).
4. `buildPostCatalogueBlocks` (`context/skills.ts`) — depends on the filtered catalogue.
5. `composeSystemPromptChunks` (sibling `../system-prompt.ts`).
6. `runToolLoop` (`loop.ts`): `streamProviderTurn` → `persistAssistantTurn` → passive-turn nudge → `dispatchToolCall` per call, repeating while `stop_reason=tool_use`.
7. Epilogue: mark-interrupted on abort, emit `usage`, `recordAiCall`, `done`.

## Conventions

- Shared types live in `types.ts`; sibling modules import from there, never from `index.ts` (avoids an import cycle through the orchestrator).
- The formatters (`formatThemeBlock`, `composeSystemPromptChunks`, …) live in the sibling `../system-prompt.ts`; the `context/*` builders call them but do not own them.
- `context/skills.ts` carries a pre-existing raw-SQL `engaged_skills` read (a CLAUDE.md §2 deviation) moved here verbatim from the monolith — preserved, not introduced; converting it to a named op is a tracked follow-up.
