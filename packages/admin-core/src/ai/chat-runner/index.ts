// SPDX-License-Identifier: MPL-2.0

/**
 * Orchestrates a single user→AI turn:
 *   1. Persist the user message + chips.
 *   2. Build messages history + system prompt (chunked for prompt-cache).
 *   3. Run the tool loop (see `loop.ts`): stream provider → persist assistant
 *      text + tool_calls → dispatch tools → repeat while `stop_reason=tool_use`.
 *   4. Record one ai_calls row aggregating usage across the loop.
 *
 * P5.2: `abortSignal` propagates to the provider stream and every yield site;
 * tool dispatch is deduped by (chat_session_id, tool_call_id) so a runner
 * re-entry can't mutate the same module twice; `composeSystemPromptChunks`
 * returns ordered chunks the Anthropic adapter caches selectively.
 *
 * This file is the orchestration entry point of the `chat-runner/` split
 * (issue #15); per-concern logic lives in the sibling modules. The pre-split
 * `../chat-runner.ts` is now a thin re-export shim onto this module.
 */

import { execute } from "@caelo-cms/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";

import type { ChatMessageInput } from "../provider.js";
import { composeSystemPromptChunks } from "../system-prompt.js";
import { attachGatedExecute } from "../tools/gated-tools.js";
import { buildProviderHistory, createMediaAttachmentLoader } from "./attachments.js";
import {
  resolveCompactionRecentTokens,
  resolveCompactionTargetTokens,
  resolveCompactionThresholdTokens,
  resolveProactiveCompaction,
} from "./compaction.js";
import { lastNoteSignature, noteSignature } from "./context/page.js";
import { extractLoadedSkillSlugs } from "./context/skills.js";
import { buildSystemContextBlocks } from "./context-blocks.js";
import { buildContextSplitEstimate } from "./context-split.js";
import {
  DEFAULT_INPUT_COST_PER_M,
  DEFAULT_OUTPUT_COST_PER_M,
  finalUsdCost,
  resolveMaxOutputTokensDefault,
} from "./limits.js";
import { runToolLoop } from "./loop.js";
import { resolveModelCostPerMTok } from "./model-cost.js";
import {
  loadMemory,
  loadSession,
  markInterrupted,
  persistApprovalResponse,
  persistUserMessage,
  recordAiCall,
} from "./persistence.js";
import type { UsageAccumulator } from "./streaming.js";
import { buildToolCatalogue, resolveExcludedToolNames } from "./tool-catalogue.js";
import type { ChatRunnerOptions, ClientEvent } from "./types.js";

export { isLegitimateTextOnlyTurn } from "./passive-turn.js";
// Public surface re-exports — the `../chat-runner.ts` shim does `export *`
// from here, so these keep the pre-split import paths working.
export type { ChatRunnerOptions, ClientEvent } from "./types.js";

export async function* runChatTurn(
  options: ChatRunnerOptions,
  input: ChatSendMessageInput,
): AsyncIterable<ClientEvent> {
  const { adapter, registry, provider, tools, aiCtx, humanCtx, abortSignal } = options;
  // Cost per MTok: explicit option wins, else the ACTIVE model's ai_pricing
  // row (same source `record_ai_call` bills from), else the Opus-tier
  // DEFAULT_* as a last resort. Without this the streamed `usage.cost`
  // fell back to the Opus-4.7 constants for EVERY model — a live
  // claude-sonnet-5 turn reported ~5× its real cost
  // (run-logs/token-efficiency-analysis.md). ai_pricing stores microcents
  // per 1K tokens → USD per MTok is `microcents / 100_000`.
  const modelRates = await resolveModelCostPerMTok(registry, adapter, humanCtx, provider);
  const inputCost =
    options.inputCostPerMTok ?? modelRates?.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
  const outputCost =
    options.outputCostPerMTok ?? modelRates?.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
  // v0.3.20 — raised from 5 to 25. Multi-section authoring sessions
  // routinely need >5 tool-use round-trips; see the cap-exhaustion notice
  // in loop.ts for the visible-signal half of the fix.
  const maxLoops = options.maxToolLoops ?? 25;
  const startedAt = Date.now();
  const aborted = (): boolean => abortSignal?.aborted === true;
  // v0.2.57 — entry breadcrumb on console.error so Bun + SvelteKit's stdout
  // path (which swallows console.info/log in production) doesn't drop it.
  console.error("[chat-runner] enter", {
    chatSessionId: input.chatSessionId,
    actorKind: aiCtx.actorKind,
    maxLoops,
    maxOutputTokens: options.maxOutputTokens,
  });

  // Run #10 D5 — per-phase timing so a pre-provider stall (run #10: 12
  // silent minutes on a fresh chat's first turn) is attributable from
  // logs alone: every phase between "enter" and the first provider
  // call gets its own duration in the `turn-phases` breadcrumb below,
  // and streaming.ts logs provider-call time-to-first-event.
  const phaseMs: Record<string, number> = {};
  let phaseStartedAt = Date.now();
  const markPhase = (name: string): void => {
    phaseMs[name] = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
  };

  // 1. Persist the turn's opening row. A resume turn (Plan B) records the
  // Owner's in-chat approval decision as a tool-approval-response row instead
  // of an operator message; the paused gated turn then resumes from history.
  if (input.resumeApproval) {
    const ok = await persistApprovalResponse(
      registry,
      adapter,
      humanCtx,
      input.chatSessionId,
      input.resumeApproval,
    );
    if (!ok) {
      yield { kind: "error", message: "failed to persist approval response" };
      yield { kind: "done" };
      return;
    }
  } else if (!(await persistUserMessage(registry, adapter, humanCtx, input))) {
    yield { kind: "error", message: "failed to persist user message" };
    yield { kind: "done" };
    return;
  }
  markPhase("persistUserMessageMs");

  // 2. Load memory + history.
  const memory = await loadMemory(registry, adapter, humanCtx);
  const session = await loadSession(registry, adapter, humanCtx, input.chatSessionId);
  markPhase("loadMemoryAndSessionMs");
  if (!session) {
    yield { kind: "error", message: "failed to load session" };
    yield { kind: "done" };
    return;
  }

  // v0.9.0 — branch-aware ctx for every downstream read so the AI's
  // pages.list / layouts.list / templates.list / pages.get etc. include the
  // chat's own branched-create entities.
  // issue #264 — a subagent turn runs on its PARENT chat's branch (the
  // spawn handler sets chatBranchIdOverride) so its reads and writes
  // share the orchestrator's preview/publish/undo scope.
  const chatBranchId = options.chatBranchIdOverride ?? session.session.chatBranchId;
  const humanCtxWithBranch: ExecutionContext = {
    ...humanCtx,
    chatBranchId,
    chatTaskId: input.chatSessionId,
  };
  // AI calls all run with chatBranchId set so the snapshot lands tagged.
  // (Defined here — before the tool catalogue — so gated tools can close
  // their `propose` leg over it; the `execute_proposal` leg uses the Owner's
  // live ctx below.)
  const aiCtxWithBranch: ExecutionContext = {
    ...aiCtx,
    chatBranchId,
    chatTaskId: input.chatSessionId,
  };

  // v0.2.54 — Resolve extended-thinking config for THIS turn. Per-chat-session
  // toggle wins for the MAIN chat; budget falls back to a default under the
  // 32k max_tokens floor.
  //
  // Subagents NEVER think, regardless of the session default. The thinking
  // A/B showed subagent turns are where thinking's cost + latency concentrate
  // with no correctness upside — the 3 parallel genesis draft children each
  // reasoned ~3x deeper (18-24k output tokens/draft, 174-215s each) and
  // doubled the scenario wall-clock. The parent plans with thinking; the
  // workers execute without it. (subagentResultCapture is present iff this
  // turn is a spawned child — see isSubagentTurn below.)
  const thinkingEnabled =
    session.session.extendedThinkingEnabled && options.subagentResultCapture === undefined;
  const thinkingBudget = thinkingEnabled
    ? (session.session.extendedThinkingBudgetTokens ?? 10000)
    : null;
  console.error("[chat-runner] session", {
    chatSessionId: input.chatSessionId,
    thinkingEnabled,
    thinkingBudget,
    historyLen: session.messages.length,
    chips: input.chips.length,
  });

  // Provider message history is everything in the chat now (the user message
  // we just appended is in there too). v0.2.54 — prior thinking blocks are
  // included so Anthropic can verify signatures across tool-use boundaries.
  // issue #190 — the most recent user message's attachments are inlined
  // as image parts; older ones become text markers (see attachments.ts).
  const baseMessages: ChatMessageInput[] = await buildProviderHistory(
    session.messages,
    createMediaAttachmentLoader(registry, adapter, humanCtx),
  );
  markPhase("buildProviderHistoryMs");

  // Progressive-disclosure skills: recover which skills the model already
  // loaded this chat (from prior load_skill tool calls in the history) so their
  // tools stay preloaded and the subagent-hint heuristic sees their bodies.
  const loadedSkillSlugs = extractLoadedSkillSlugs(session.messages);

  // Build all pre-catalogue system-prompt context blocks + skill engagement.
  const ctx = await buildSystemContextBlocks({
    registry,
    adapter,
    humanCtx,
    humanCtxWithBranch,
    aiActorId: aiCtx.actorId,
    input,
    loadedSkillSlugs,
  });
  markPhase("contextBlocksMs");

  // The cold-start status ("Theme: needs setup", …) and the current-page
  // context ("where am I") ride on the MESSAGE FLOW, never the system prompt
  // (operator's rule: nothing dynamic in the system prompt). Each is injected
  // as an origin=system note on the FIRST turn and again only when it CHANGED
  // since we last told the model (djb2 signature vs the last <!--marker:SIG-->
  // in the history), persisted so it stays in the append-only history and the
  // change-check survives across turns. All other live site state is fetched
  // on-demand via the list_/get_ tools.
  const injectNote = async (marker: string, seed: string, body: string): Promise<void> => {
    const sig = noteSignature(seed);
    if (lastNoteSignature(session.messages, marker) === sig) return;
    const full = `${body}\n<!--${marker}:${sig}-->`;
    await execute(registry, adapter, humanCtx, "chat.append_message", {
      chatSessionId: input.chatSessionId,
      role: "user",
      origin: "system",
      content: full,
    });
    baseMessages.push({ role: "user", content: full });
  };
  if (ctx.statusLine && ctx.statusLine.trim().length > 0) {
    await injectNote("status", ctx.statusLine, ctx.statusLine);
  }
  if (ctx.pageContextBlock && ctx.pageContextBlock.trim().length > 0 && input.activePageId) {
    await injectNote("pagectx", `${input.activePageId}\n${ctx.pageContextBlock}`, ctx.pageContextBlock);
  }

  // P10A skill allowlist intersection ∪ P10.5 subagent exclusion
  // ∪ issue #264 per-spawn allowlist. Run #10 D2 — `submit_result`
  // joins the exclusions unless this turn IS a subagent child (i.e.
  // subagentResultCapture is present).
  const effectiveExcluded = resolveExcludedToolNames(
    options.excludedToolNames,
    options.subagentResultCapture !== undefined,
  );
  const catalogueTools = buildToolCatalogue({
    tools,
    allowedToolNames: ctx.allowedToolNames,
    engagedSkills: ctx.engagedSkills,
    excluded: effectiveExcluded,
    spawnAllowed: options.allowedToolNames,
    chatSessionId: input.chatSessionId,
  });
  // Plan B (SDK approval gate) — a gated catalogue tool is SDK-executed:
  // attach its `execute`, which after the Owner's in-chat Approve chains the
  // existing per-domain `propose` (AI ctx — writes the pending row + preview +
  // audit) then `execute_proposal` (Owner live ctx — applies the real
  // mutation, exactly as the old /security/pending Approve did). Reusing that
  // machinery keeps every domain's apply logic correct with zero
  // reimplementation. Subagent turns strip gated tools outright — a child
  // never fronts an Owner approval.
  const isSubagentTurn = options.subagentResultCapture !== undefined;
  const filteredTools = catalogueTools.flatMap((t) => {
    if (!t.gated) return [t];
    if (isSubagentTurn) return [];
    return [attachGatedExecute(t, registry, adapter, aiCtxWithBranch, humanCtx)];
  });

  // The system prompt is fully static now — the only passthrough is the static
  // skills index. Subagent guidance is a static chunk; the old plugin /
  // plugin-context blocks were dynamic and are dropped (the AI reaches plugin
  // state on-demand via tools).
  const systemChunks = composeSystemPromptChunks(memory, {
    skillsIndexBlock: ctx.preBlocks.skillsIndexBlock,
  });

  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0, totalCacheCreation: 0 };

  markPhase("catalogueAndPromptMs");
  // Run #10 D5 — the pre-provider timing breadcrumb. If a first token
  // ever goes silent again, this log (plus streaming.ts's
  // provider-first-event / provider-first-event-timeout) pins WHICH
  // phase ate the time.
  console.error("[chat-runner] turn-phases", {
    chatSessionId: input.chatSessionId,
    ...phaseMs,
    totalPreProviderMs: Date.now() - startedAt,
  });

  // issue #300 part A — one context-split line per turn: where the
  // loop-0 input tokens go (system prompt / per-label context blocks /
  // per-skill bodies / tool catalogue / history), chars/4 ESTIMATE.
  // This is the yardstick every future context diet is measured with.
  console.error("[chat-runner] context-split", {
    chatSessionId: input.chatSessionId,
    ...buildContextSplitEstimate({
      systemChunks,
      providerTools: filteredTools,
      messages: baseMessages,
    }),
  });

  // 3. Run the tool loop.
  const { stopReason, succeeded, lastAssistantMessageId } = yield* runToolLoop({
    registry,
    adapter,
    humanCtx,
    aiCtxWithBranch,
    provider,
    tools,
    options,
    runChatTurn,
    chatSessionId: input.chatSessionId,
    chatBranchId,
    abortSignal,
    systemChunks,
    filteredTools,
    initialMessages: baseMessages,
    // issue #261 — compaction trigger; env-tunable, fires ~800K real by
    // default. Trigger, target (~200K real) and recent-tail budget (~100K
    // real) are separate so compaction fires late and drops hard.
    compactionThresholdTokens: resolveCompactionThresholdTokens(),
    compactionTargetTokens: resolveCompactionTargetTokens(),
    compactionRecentTokens: resolveCompactionRecentTokens(),
    proactiveCompaction: resolveProactiveCompaction(),
    maxLoops,
    // Run #8 R1 — model-aware default: adaptive-thinking models share the
    // output budget with thinking and need >=32k headroom (see limits.ts).
    maxOutputTokens: options.maxOutputTokens ?? resolveMaxOutputTokensDefault(provider.model),
    temperature: options.temperature,
    thinkingBudget,
    usage,
    costCapMicrocents: options.costCapMicrocents,
    inputCost,
    outputCost,
  });

  if (aborted() && lastAssistantMessageId) {
    await markInterrupted(registry, adapter, humanCtx, lastAssistantMessageId);
  }

  const usdCost = finalUsdCost(usage.totalIn, usage.totalOut, inputCost, outputCost);
  yield {
    kind: "usage",
    inputTokens: usage.totalIn,
    outputTokens: usage.totalOut,
    cachedTokens: usage.totalCached,
    cost: usdCost,
  };

  // 4. Record one ai_calls row aggregating usage across the loop.
  await recordAiCall(registry, adapter, humanCtx, {
    chatSessionId: input.chatSessionId,
    provider: provider.name,
    model: provider.model,
    inputTokens: usage.totalIn,
    outputTokens: usage.totalOut,
    cachedTokens: usage.totalCached,
    // P16 — canonical price comes from the ai_pricing table inside the op.
    durationMs: Date.now() - startedAt,
    succeeded: succeeded && stopReason !== "error" && !aborted(),
    // P10.5 — parent attribution flows through aiCtx for subagent turns.
    parentChatSessionId: aiCtx.parentChatSessionId,
    parentAiCallId: aiCtx.parentAiCallId,
    // P16 — request_id flows through aiCtx if hooks.server.ts threaded it.
    requestId: aiCtx.requestId ?? null,
  });

  if (aborted()) {
    yield { kind: "interrupted", messageId: lastAssistantMessageId };
  }
  yield { kind: "done" };
}
