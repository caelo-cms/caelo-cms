// SPDX-License-Identifier: MPL-2.0

/**
 * Single tool-call dispatch for the chat-runner loop. Extracted verbatim from
 * the pre-split `chat-runner.ts` (P5.2 dedup, P10.5 subagent event streaming,
 * P11.5 Tier-1 plugin routing, v0.6.0 auto-recovery, v0.3.0 multimodal image).
 *
 * Yielded as `yield*` from the loop in `index.ts`; it mutates the provider
 * `messages` array in place (tool result + optional screenshot user message)
 * exactly as the inline loop did.
 */

import { pluginToolsRegistry, runPluginOperation } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import { tryAutoRecover } from "../auto-recovery.js";
import type { AIProvider, ChatMessageInput } from "../provider.js";
import type { ToolRegistry } from "../tools/index.js";
import type {
  AccumulatedToolCall,
  ChatRunnerOptions,
  ClientEvent,
  RunChatTurnFn,
  ToolDispatchResult,
} from "./types.js";

/** Everything `dispatchToolCall` needs from the orchestrator. */
export interface DispatchDeps {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  humanCtx: ExecutionContext;
  aiCtxWithBranch: ExecutionContext;
  provider: AIProvider;
  tools: ToolRegistry;
  chatSessionId: string;
  chatBranchId: string;
  options: ChatRunnerOptions;
  runChatTurn: RunChatTurnFn;
}

/**
 * Dispatch one tool call: dedup-cache lookup, plugin-vs-builtin routing with
 * live subagent-event streaming, auto-recovery, result caching, and the
 * tool-result message append (+ multimodal screenshot append). Mutates
 * `messages` in place.
 */
export async function* dispatchToolCall(
  call: AccumulatedToolCall,
  messages: ChatMessageInput[],
  deps: DispatchDeps,
  /**
   * Run #8 live-edit CI — image follow-up messages are DEFERRED here
   * instead of pushed into `messages` inline. With two image-returning
   * tool calls in one assistant turn (e.g. parallel `screenshot_page`
   * for desktop + mobile), the inline push produced
   * [assistant(tool_use A,B), tool A, user(image A), tool B, …] and the
   * provider SDK rejected the history with AI_MissingToolResultsError:
   * a user message may not appear before every tool call of the turn
   * has its result. The loop appends this array AFTER all of the
   * turn's tool results.
   */
  deferredImageMessages: ChatMessageInput[],
): AsyncGenerator<ClientEvent, void> {
  const { registry, adapter, humanCtx, aiCtxWithBranch, provider, tools, options } = deps;

  yield {
    kind: "tool-start",
    toolCallId: call.id,
    name: call.name,
    arguments: call.arguments,
  };

  const cachedLookup = await execute(registry, adapter, humanCtx, "chat.lookup_tool_result", {
    chatSessionId: deps.chatSessionId,
    toolCallId: call.id,
  });
  const cachedHit =
    cachedLookup.ok &&
    (cachedLookup.value as { cached: { ok: boolean; content: string } | null }).cached;

  let result: ToolDispatchResult;
  if (cachedHit) {
    result = {
      ok: cachedHit.ok,
      content: cachedHit.content,
    };
    yield { kind: "tool-result-cached", toolCallId: call.id };
  } else {
    // P10.5 #1 — buffer + waker so the spawn handler can stream
    // child events to the parent's generator while its dispatch is
    // still in flight. Tool handlers that don't push events leave
    // the queue empty and the loop is a no-op.
    const eventBuffer: ClientEvent[] = [];
    let resolveWaker: (() => void) | null = null;
    const wakeReader = (): void => {
      const r = resolveWaker;
      resolveWaker = null;
      r?.();
    };
    const pushClientEvent = (event: unknown): void => {
      eventBuffer.push(event as ClientEvent);
      wakeReader();
    };

    // P11.5 commit 2 — Tier-1 plugin tools route through plugin-host's
    // runPluginOperation. Built-in tools fall through to tools.dispatch.
    const pluginTool = pluginToolsRegistry.resolve(call.name);
    const dispatchPromise: Promise<ToolDispatchResult> = pluginTool
      ? runPluginOperation({
          pluginSlug: pluginTool.pluginSlug,
          operationName: pluginTool.spec.operationName,
          args: call.arguments,
        }).then((r) =>
          r.ok
            ? { ok: true, content: JSON.stringify(r.value) }
            : { ok: false, content: `${r.error.kind}: ${r.error.message}` },
        )
      : tools.dispatch(call.name, call.arguments, aiCtxWithBranch, {
          adapter,
          registry,
          chatSessionId: deps.chatSessionId,
          chatBranchId: deps.chatBranchId,
          // Run #10 D2 — present only on subagent child turns; makes
          // the submit_result tool deliver its validated payload to
          // the waiting spawn handler.
          ...(options.subagentResultCapture
            ? { subagentResultCapture: options.subagentResultCapture }
            : {}),
          // P10.5 — expose provider + tools + humanCtx + a child-turn
          // factory so the spawn_subagent handler can invoke runChatTurn
          // recursively for the child without a circular import. The
          // factory always passes excludedToolNames including the spawn
          // tools, so the depth cap is enforced by configuration, not a
          // runtime branch.
          provider,
          tools,
          humanCtx,
          pushClientEvent,
          spawnChildChatTurn: ({
            chatInput,
            aiCtx: childAiCtx,
            humanCtx: childHumanCtx,
            excludedToolNames,
            allowedToolNames,
            chatBranchIdOverride,
            costCapMicrocents,
            subagentResultCapture,
            abortSignal: childAbort,
          }) =>
            deps.runChatTurn(
              {
                adapter,
                registry,
                provider,
                tools,
                aiCtx: childAiCtx,
                humanCtx: childHumanCtx,
                inputCostPerMTok: options.inputCostPerMTok,
                outputCostPerMTok: options.outputCostPerMTok,
                maxToolLoops: options.maxToolLoops,
                excludedToolNames,
                allowedToolNames,
                chatBranchIdOverride,
                costCapMicrocents,
                // Run #10 D2 — the child turn carries the parent's
                // result capture so its catalogue includes
                // submit_result and the payload lands in the spawn
                // handler's closure.
                subagentResultCapture,
                abortSignal: childAbort,
              },
              chatInput,
            ),
        });
    let dispatchDone = false;
    const finalDispatch = dispatchPromise.then(
      (r) => {
        dispatchDone = true;
        wakeReader();
        return { ok: true as const, value: r };
      },
      (e: unknown) => {
        dispatchDone = true;
        wakeReader();
        return { ok: false as const, error: e };
      },
    );

    // Drain the event buffer concurrently with the dispatch.
    while (!dispatchDone || eventBuffer.length > 0) {
      while (eventBuffer.length > 0) {
        const ev = eventBuffer.shift();
        if (ev) yield ev;
      }
      if (!dispatchDone) {
        await new Promise<void>((resolve) => {
          resolveWaker = resolve;
        });
      }
    }
    const settled = await finalDispatch;
    if (settled.ok) {
      result = settled.value;
      // v0.6.0 W3 — auto-recover from structured failures. When a
      // bootstrap-flow op fails with `nextAction.autoExecute=true`
      // and the suggested tool is read-only, the helper dispatches
      // the recovery + (optionally) re-dispatches the original
      // with rewritten args. AI sees a clean result in either
      // success-with-retry or fold-into-content shape. See
      // auto-recovery.ts for the full flow + safety guards.
      if (!result.ok && result.nextAction?.autoExecute) {
        result = await tryAutoRecover({
          failed: result,
          originalCall: { name: call.name, arguments: call.arguments },
          tools,
          aiCtx: aiCtxWithBranch,
          toolCtx: {
            adapter,
            registry,
            chatSessionId: deps.chatSessionId,
            chatBranchId: deps.chatBranchId,
            provider,
            tools,
            humanCtx,
          },
          chatSessionId: deps.chatSessionId,
        });
      }
    } else {
      // v0.2.52 — A tool handler rejected (Zod runtime, plugin error,
      // DB constraint, "Cannot read X of undefined"). Surface as a
      // failed tool_result instead of aborting the turn: the AI sees
      // the failure on the next provider call and decides whether to
      // retry, switch tools, or give up gracefully. Pre-v0.2.52 this
      // line threw, the generator aborted mid-loop, the SSE handler
      // caught + emitted error+done, and tool_result rows for the
      // failing + remaining tools were never persisted. Stderr is
      // captured by Cloud Run so the next regression in this class is
      // debuggable from logs alone.
      console.error("[chat-runner] tool dispatch threw", {
        chatSessionId: deps.chatSessionId,
        toolName: call.name,
        toolCallId: call.id,
        error: settled.error,
      });
      const errMsg = settled.error instanceof Error ? settled.error.message : String(settled.error);
      result = { ok: false, content: `tool error: ${errMsg}` };
    }
    await execute(registry, adapter, humanCtx, "chat.cache_tool_result", {
      chatSessionId: deps.chatSessionId,
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
    chatSessionId: deps.chatSessionId,
    role: "tool",
    content: result.content,
    toolCallId: call.id,
  });
  messages.push({ role: "tool", content: result.content, toolCallId: call.id });
  // v0.3.0 — when the tool returned an image (screenshot_page is
  // the only producer today), build a multimodal user message so the
  // AI sees the image alongside the text result on its next provider
  // call. Image content is NOT persisted to chat_messages — it's
  // runtime-only. After publish, the chat history shows only the text
  // result; the image was consumed by the AI for that turn. Deferred
  // (not pushed inline) so parallel image-returning calls keep every
  // tool result ahead of the first user message — see the parameter
  // doc above.
  if (result.image) {
    deferredImageMessages.push({
      role: "user",
      content: `[Screenshot returned by ${call.name}; analyse it for the operator's request.]`,
      additionalContent: [
        { type: "image", base64: result.image.base64, mediaType: result.image.mediaType },
      ],
    });
  }
}
