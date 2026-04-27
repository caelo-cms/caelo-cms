// SPDX-License-Identifier: MPL-2.0

/**
 * Orchestrates a single user→AI turn:
 *   1. Persist the user message + chips.
 *   2. Build messages history + system prompt (chunked for prompt-cache).
 *   3. Loop:
 *      - call provider.generate (signal-aware)
 *      - relay text deltas to the client (yielded events)
 *      - persist any assistant text + tool_calls
 *      - dispatch each tool (skip + replay cached if dup id) and
 *        persist the tool result
 *      - if the model said `stop_reason=tool_use`, loop again with the
 *        new transcript so the model can read the tool result and reply
 *      - else exit
 *   4. Record one ai_calls row aggregating usage across the loop.
 *
 * P5.2 additions:
 *  - `abortSignal` propagates to the provider stream and to every
 *    yield site; on abort the in-flight assistant message is marked
 *    `status='interrupted'` and tool dispatch stops mid-loop.
 *  - Tool-call dispatch is deduped by (chat_session_id, tool_call_id)
 *    via `chat.lookup_tool_result` / `chat.cache_tool_result` so a
 *    runner re-entry (retry, restart, double-fire) cannot mutate the
 *    same module twice.
 *  - `composeSystemPromptChunks` returns ordered chunks the Anthropic
 *    adapter caches selectively — chips/skills (volatile) sit after
 *    the cached prefix so changing them doesn't bust the cache.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";
import { execute } from "@caelo/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo/shared";

import type { AIProvider, ChatMessageInput } from "./provider.js";
import { composeSystemPromptChunks } from "./system-prompt.js";
import type { ToolRegistry } from "./tools/index.js";

export type ClientEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-start"; toolCallId: string; name: string; arguments: unknown }
  | { kind: "tool-result"; toolCallId: string; ok: boolean; content: string }
  | { kind: "tool-result-cached"; toolCallId: string }
  | { kind: "assistant-message-saved"; messageId: string }
  | { kind: "interrupted"; messageId: string | null }
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
  /** P5.2 #2 — propagated to the provider; aborts halt the loop cleanly. */
  readonly abortSignal?: AbortSignal;
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
  const { adapter, registry, provider, tools, aiCtx, humanCtx, abortSignal } = options;
  const inputCost = options.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
  const outputCost = options.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
  const maxLoops = options.maxToolLoops ?? 5;
  const startedAt = Date.now();
  const aborted = (): boolean => abortSignal?.aborted === true;

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

  // P5.2 #4 — chunked system prompt. Chips render as a volatile chunk
  // so they don't bust the cache prefix (BASE + memory + tools).
  const chipsBlock =
    input.chips.length > 0
      ? [
          "# Element references in this turn",
          ...input.chips.map((c) => `- ${c.label} (module=${c.moduleId}, selector=${c.selector})`),
        ].join("\n")
      : undefined;

  // P6.7.3 — Current-page volatile chunk. When the live-edit surface
  // sends `activePageId`, we load the page + its modules + the
  // template's blocks and surface that as a per-call context block so
  // the AI knows what's on the page and which tool to use ("I want a
  // button at the top" → add_module_to_page; "make the hero red" →
  // edit_module on the matching module-id).
  let pageContextBlock: string | undefined;
  if (input.activePageId) {
    const pageR = await execute(registry, adapter, humanCtx, "pages.get_with_modules", {
      pageId: input.activePageId,
    });
    if (pageR.ok) {
      const v = pageR.value as {
        page: {
          id: string;
          slug: string;
          locale: string;
          title: string;
          status: string;
          templateId: string;
          blocks: {
            blockName: string;
            modules: { moduleId: string; slug: string; displayName: string; html: string }[];
          }[];
        };
      };
      const lines: string[] = [
        "# Current page",
        `Page: ${v.page.slug} (locale=${v.page.locale}, status=${v.page.status}, id=${v.page.id})`,
        `Template id: ${v.page.templateId}`,
        `Blocks (in render order): ${v.page.blocks.map((b) => b.blockName).join(", ") || "(none)"}`,
        "",
        "## Modules currently on this page",
      ];
      for (const b of v.page.blocks) {
        if (b.modules.length === 0) {
          lines.push(`- block "${b.blockName}": (empty)`);
          continue;
        }
        for (let i = 0; i < b.modules.length; i++) {
          const m = b.modules[i];
          if (!m) continue;
          const snippet = m.html.length > 200 ? `${m.html.slice(0, 200)}…` : m.html;
          lines.push(
            `- block "${b.blockName}" pos ${i}: id=${m.moduleId} slug=${m.slug} (${m.displayName}) — ${snippet}`,
          );
        }
      }
      lines.push("");
      lines.push(
        "Tool guidance:",
        "- edit_module — change an existing module's content (always reference a real module id from the list above).",
        "- add_module_to_page — insert a NEW module into a block on THIS page only. Use this for one-off content (a CTA on the homepage, an FAQ section on /about). Position is 'top', 'bottom', or a 0-based index.",
        '- add_module_to_template — create a NEW module and fan it out to EVERY page using this template at the same block + position. Use this only when the user explicitly asks for site-wide content ("add a footer to every page", "a header banner across the site"). Pass the templateId from this block\'s header.',
      );
      pageContextBlock = lines.join("\n");
    }
  }

  const systemChunks = composeSystemPromptChunks(
    memory,
    tools.catalogue().map((t) => ({ name: t.name, description: t.description })),
    { chipsBlock, pageContextBlock },
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
  let lastAssistantMessageId: string | null = null;

  for (let loop = 0; loop < maxLoops; loop++) {
    if (aborted()) break;
    const accumulatedText: string[] = [];
    const accumulatedToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    let loopStop: StopReason = "end_turn";

    let providerErr = false;
    for await (const ev of provider.generate({
      systemPrompt: systemChunks,
      messages,
      tools: tools.catalogue(),
      abortSignal,
    })) {
      if (aborted()) break;
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
      status: aborted() ? "interrupted" : "complete",
    });
    if (assistantSave.ok) {
      lastAssistantMessageId = (assistantSave.value as { messageId: string }).messageId;
      yield {
        kind: "assistant-message-saved",
        messageId: lastAssistantMessageId,
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

    if (aborted()) break;
    if (loopStop !== "tool_use" || accumulatedToolCalls.length === 0) {
      stopReason = loopStop;
      break;
    }

    // Dispatch each tool call sequentially and append a tool result.
    // P5.2 #3 — dedupe by (chat_session_id, tool_call_id).
    for (const call of accumulatedToolCalls) {
      if (aborted()) break;
      yield {
        kind: "tool-start",
        toolCallId: call.id,
        name: call.name,
        arguments: call.arguments,
      };

      const cachedLookup = await execute(registry, adapter, humanCtx, "chat.lookup_tool_result", {
        chatSessionId: input.chatSessionId,
        toolCallId: call.id,
      });
      const cachedHit =
        cachedLookup.ok &&
        (cachedLookup.value as { cached: { ok: boolean; content: string } | null }).cached;

      let result: { ok: boolean; content: string };
      if (cachedHit) {
        result = {
          ok: cachedHit.ok,
          content: cachedHit.content,
        };
        yield { kind: "tool-result-cached", toolCallId: call.id };
      } else {
        result = await tools.dispatch(call.name, call.arguments, aiCtxWithBranch, {
          adapter,
          registry,
          chatSessionId: input.chatSessionId,
          chatBranchId: session.session.chatBranchId,
        });
        await execute(registry, adapter, humanCtx, "chat.cache_tool_result", {
          chatSessionId: input.chatSessionId,
          toolCallId: call.id,
          toolName: call.name,
          ok: result.ok,
          content: result.content,
        });
      }

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

  if (aborted() && lastAssistantMessageId) {
    await execute(registry, adapter, humanCtx, "chat.mark_message_interrupted", {
      messageId: lastAssistantMessageId,
    });
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
    succeeded: succeeded && stopReason !== "error" && !aborted(),
  });

  if (aborted()) {
    yield { kind: "interrupted", messageId: lastAssistantMessageId };
  }
  yield { kind: "done" };
}
