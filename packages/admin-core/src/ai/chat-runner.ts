// SPDX-License-Identifier: MPL-2.0

/**
 * Orchestrates a single user→AI turn:
 *   1. Persist the user message + chips.
 *   2. Build messages history + system prompt.
 *   3. Loop:
 *      - call provider.generate
 *      - relay text deltas to the client (yielded events)
 *      - persist any assistant text + tool_calls
 *      - dispatch each tool; persist the tool result message
 *      - if the model said `stop_reason=tool_use`, loop again with the
 *        new transcript so the model can read the tool result and reply
 *      - else exit
 *   4. Record one ai_calls row aggregating usage across the loop.
 *
 * All persistence goes through Query API ops (one tx each) so a tool
 * call lands its own snapshot via the existing emitSnapshot path on
 * `modules.update` — the AI's writes are revertible exactly like a
 * human's.
 *
 * The runner yields a typed event stream the SSE endpoint relays to the
 * browser. No provider-brand strings leak into client-facing event
 * shapes.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";
import { execute } from "@caelo/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo/shared";

import type { AIProvider, ChatMessageInput } from "./provider.js";
import { composeSystemPrompt } from "./system-prompt.js";
import type { ToolRegistry } from "./tools/index.js";

export type ClientEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-start"; toolCallId: string; name: string; arguments: unknown }
  | { kind: "tool-result"; toolCallId: string; ok: boolean; content: string }
  | { kind: "assistant-message-saved"; messageId: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface ChatRunnerOptions {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly provider: AIProvider;
  readonly tools: ToolRegistry;
  /** AI actor identity used for tool dispatches (writes hit DB as `ai`). */
  readonly aiCtx: ExecutionContext;
  /** Human identity used for user-message persistence + the chat row. */
  readonly humanCtx: ExecutionContext;
  /** Optional cost-per-million-tokens (USD). Falls back to a P5 default. */
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
  readonly maxToolLoops?: number;
}

const DEFAULT_INPUT_COST_PER_M = 15; // Opus 4.7 input rate, USD per 1M tokens
const DEFAULT_OUTPUT_COST_PER_M = 75;

function microcents(usd: number): number {
  // 1 USD = 1e8 microcents.
  return Math.round(usd * 1e8);
}

export async function* runChatTurn(
  options: ChatRunnerOptions,
  input: ChatSendMessageInput,
): AsyncIterable<ClientEvent> {
  const { adapter, registry, provider, tools, aiCtx, humanCtx } = options;
  const inputCost = options.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
  const outputCost = options.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
  const maxLoops = options.maxToolLoops ?? 5;
  const startedAt = Date.now();

  // 1. Persist the user message.
  const userContent =
    input.chips.length > 0
      ? [
          input.content,
          "",
          "Element references attached to this message:",
          ...input.chips.map(
            (c) => `  - ${c.label} (module=${c.moduleId.slice(0, 8)}, selector=${c.selector})`,
          ),
        ].join("\n")
      : input.content;

  const userMsg = await execute(registry, adapter, humanCtx, "chat.append_message", {
    chatSessionId: input.chatSessionId,
    role: "user",
    content: userContent,
  });
  if (!userMsg.ok) {
    yield { kind: "error", message: "failed to persist user message" };
    yield { kind: "done" };
    return;
  }

  // 2. Load memory + history.
  const memoryResult = await execute(registry, adapter, humanCtx, "ai_memory.list", {});
  const memory = memoryResult.ok
    ? (memoryResult.value as { memory: { slot: string; body: string }[] }).memory
    : [];

  const sessionResult = await execute(registry, adapter, humanCtx, "chat.get_session", {
    chatSessionId: input.chatSessionId,
  });
  if (!sessionResult.ok) {
    yield { kind: "error", message: "failed to load session" };
    yield { kind: "done" };
    return;
  }
  const session = sessionResult.value as {
    session: { chatBranchId: string };
    messages: {
      role: "user" | "assistant" | "tool";
      content: string;
      toolCalls: unknown;
      toolCallId: string | null;
    }[];
  };

  // Provider message history is everything in the chat now (the user
  // message we just appended is in there too).
  const baseMessages: ChatMessageInput[] = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCalls: Array.isArray(m.toolCalls)
      ? (m.toolCalls as { id: string; name: string; arguments: unknown }[])
      : undefined,
    toolCallId: m.toolCallId ?? undefined,
  }));

  const systemPrompt = composeSystemPrompt(
    memory,
    tools.catalogue().map((t) => ({ name: t.name, description: t.description })),
  );

  // AI calls all run with chatBranchId set so the snapshot lands tagged.
  const aiCtxWithBranch: ExecutionContext = {
    ...aiCtx,
    chatBranchId: session.session.chatBranchId,
    chatTaskId: input.chatSessionId,
  };

  let messages = [...baseMessages];
  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;
  let succeeded = true;
  type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";
  let stopReason: StopReason = "end_turn";

  for (let loop = 0; loop < maxLoops; loop++) {
    const accumulatedText: string[] = [];
    const accumulatedToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    let loopStop: StopReason = "end_turn";

    let providerErr = false;
    for await (const ev of provider.generate({
      systemPrompt,
      messages,
      tools: tools.catalogue(),
      cacheBreakpoints: ["system", "tools"],
    })) {
      if (ev.kind === "text-delta") {
        accumulatedText.push(ev.text);
        yield { kind: "text-delta", text: ev.text };
      } else if (ev.kind === "tool-call") {
        accumulatedToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      } else if (ev.kind === "usage") {
        totalIn += ev.inputTokens;
        totalOut += ev.outputTokens;
        totalCached += ev.cachedTokens;
      } else if (ev.kind === "done") {
        loopStop = ev.stopReason;
      } else if (ev.kind === "error") {
        providerErr = true;
        succeeded = false;
        yield { kind: "error", message: ev.message };
      }
    }
    if (providerErr) {
      stopReason = "error";
      break;
    }

    const assistantContent = accumulatedText.join("");
    const assistantSave = await execute(registry, adapter, humanCtx, "chat.append_message", {
      chatSessionId: input.chatSessionId,
      role: "assistant",
      content: assistantContent,
      toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : null,
    });
    if (assistantSave.ok) {
      yield {
        kind: "assistant-message-saved",
        messageId: (assistantSave.value as { messageId: string }).messageId,
      };
    }

    // Update messages history for the potential next loop iteration.
    messages = [
      ...messages,
      {
        role: "assistant",
        content: assistantContent,
        toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
      },
    ];

    if (loopStop !== "tool_use" || accumulatedToolCalls.length === 0) {
      stopReason = loopStop;
      break;
    }

    // Dispatch each tool call sequentially and append a tool result.
    for (const call of accumulatedToolCalls) {
      yield {
        kind: "tool-start",
        toolCallId: call.id,
        name: call.name,
        arguments: call.arguments,
      };
      const result = await tools.dispatch(call.name, call.arguments, aiCtxWithBranch, {
        adapter,
        registry,
        chatSessionId: input.chatSessionId,
        chatBranchId: session.session.chatBranchId,
      });
      yield {
        kind: "tool-result",
        toolCallId: call.id,
        ok: result.ok,
        content: result.content,
      };
      await execute(registry, adapter, humanCtx, "chat.append_message", {
        chatSessionId: input.chatSessionId,
        role: "tool",
        content: result.content,
        toolCallId: call.id,
      });
      messages.push({ role: "tool", content: result.content, toolCallId: call.id });
    }
  }

  const usdCost = (totalIn / 1_000_000) * inputCost + (totalOut / 1_000_000) * outputCost;
  yield {
    kind: "usage",
    inputTokens: totalIn,
    outputTokens: totalOut,
    cachedTokens: totalCached,
    cost: usdCost,
  };

  await execute(registry, adapter, humanCtx, "chat.record_ai_call", {
    chatSessionId: input.chatSessionId,
    provider: provider.name,
    model: provider.model,
    inputTokens: totalIn,
    outputTokens: totalOut,
    cachedTokens: totalCached,
    costEstimateMicrocents: microcents(usdCost),
    durationMs: Date.now() - startedAt,
    succeeded: succeeded && stopReason !== "error",
  });

  yield { kind: "done" };
}
