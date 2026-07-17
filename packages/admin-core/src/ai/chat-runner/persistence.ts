// SPDX-License-Identifier: MPL-2.0

/**
 * Session save/load + chat persistence wrappers for the chat-runner. Thin
 * helpers over the `chat.*` / `ai_memory.*` Query API ops; extracted verbatim
 * from the pre-split `chat-runner.ts`. No raw SQL — every call routes through
 * `execute(registry, adapter, ctx, op, args)`.
 */

import type { DatabaseAdapter, OperationRegistry, QueryError } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";

import type { AccumulatedServerToolCall, AccumulatedToolCall } from "./types.js";

/** The session aggregate `chat.get_session` returns. */
export interface LoadedSession {
  session: {
    chatBranchId: string;
    extendedThinkingEnabled: boolean;
    extendedThinkingBudgetTokens: number | null;
  };
  messages: {
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls: unknown;
    toolCallId: string | null;
    thinkingBlocks: { thinking: string; signature: string }[] | null;
    /** issue #190 — operator-attached images on user messages. */
    attachments: import("@caelo-cms/shared").ChatAttachment[] | null;
  }[];
}

/** Compose the persisted user-message body, inlining chip references. */
export function buildUserContent(input: ChatSendMessageInput): string {
  return input.chips.length > 0
    ? [
        input.content,
        "",
        "Element references attached to this message:",
        ...input.chips.map(
          (c) => `  - ${c.label} (module=${c.moduleId.slice(0, 8)}, selector=${c.selector})`,
        ),
      ].join("\n")
    : input.content;
}

/** Persist the user's message + chips. Returns false if the append failed. */
export async function persistUserMessage(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  input: ChatSendMessageInput,
): Promise<boolean> {
  const userMsg = await execute(registry, adapter, humanCtx, "chat.append_message", {
    chatSessionId: input.chatSessionId,
    role: "user",
    content: buildUserContent(input),
    // issue #29 — carry system-origin provenance so auto-injected nudges
    // persist as muted status lines instead of operator "You:" messages.
    // Omitted when operator-authored (Zod optional; no origin column write
    // → NULL → renders as a normal user turn).
    ...(input.origin ? { origin: input.origin } : {}),
    // issue #190 — persist attachments so the transcript keeps its
    // thumbnails and the provider-history assembly sees them. The ?? []
    // matters: Zod's .default([]) only fires on PARSED input; internal
    // callers (subagents, MCP bridge, tests) construct the object
    // literally and may omit the field.
    ...((input.attachments ?? []).length > 0 ? { attachments: input.attachments } : {}),
    // issue #303 — producer hint for the empty-content rejection.
    source:
      input.origin === "system"
        ? "auto-nudge (origin=system via stream route)"
        : "operator chat message",
  });
  return userMsg.ok;
}

/** Load the AI memory slots (empty array on read failure). */
export async function loadMemory(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
): Promise<{ slot: string; body: string }[]> {
  const memoryResult = await execute(registry, adapter, humanCtx, "ai_memory.list", {});
  return memoryResult.ok
    ? (memoryResult.value as { memory: { slot: string; body: string }[] }).memory
    : [];
}

/** Load the chat session + its message history. Returns null on failure. */
export async function loadSession(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  chatSessionId: string,
): Promise<LoadedSession | null> {
  const sessionResult = await execute(registry, adapter, humanCtx, "chat.get_session", {
    chatSessionId,
  });
  if (!sessionResult.ok) return null;
  return sessionResult.value as LoadedSession;
}

/**
 * Human-readable rendering of a persist failure (the assistant-save error
 * path). Exhaustive over the QueryError union.
 */
export function describePersistError(e: QueryError): string {
  switch (e.kind) {
    case "UnknownOperation":
      return `unknown op: ${e.name}`;
    case "ValidationFailed":
      return `validation failed: ${JSON.stringify(e.issues)}`;
    case "ActorScopeRejected":
      return `actor scope rejected (${e.actorKind} on ${e.operation})`;
    case "RateLimited":
      return `rate limited on ${e.operation}`;
    case "RLSDenied":
      return `RLS denied on ${e.operation}: ${e.detail}`;
    case "HandlerError":
      return `${e.operation}: ${e.message}`;
    case "Locked":
      return `${e.operation}: ${e.message}`;
    case "SiblingLeaseConflict":
      return `${e.operation}: ${e.message}`;
  }
}

/**
 * Persist the assistant turn (text + tool_calls + thinking blocks). Returns
 * the new message id on success, or a classified failure: `sessionGone` is
 * the benign mid-stream race (PR #61), anything else is a real persist error
 * with a human-readable message.
 */
export async function persistAssistantTurn(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  args: {
    chatSessionId: string;
    content: string;
    /** Client calls + serverExecuted-tagged Tool Search calls, one jsonb. */
    toolCalls: (AccumulatedToolCall | AccumulatedServerToolCall)[] | null;
    thinkingBlocks: { thinking: string; signature: string }[] | null;
    status: "interrupted" | "complete";
  },
): Promise<{ ok: true; messageId: string } | { ok: false; sessionGone: boolean; message: string }> {
  const save = await execute(registry, adapter, humanCtx, "chat.append_message", {
    chatSessionId: args.chatSessionId,
    role: "assistant",
    content: args.content,
    toolCalls: args.toolCalls,
    thinkingBlocks: args.thinkingBlocks,
    status: args.status,
    // issue #303 — producer hint for the empty-content rejection.
    source: "chat-runner assistant turn (persistAssistantTurn)",
  });
  if (save.ok) return { ok: true, messageId: (save.value as { messageId: string }).messageId };
  const e = save.error;
  const sessionGone = e.kind === "HandlerError" && e.message.startsWith("session_gone");
  return { ok: false, sessionGone, message: describePersistError(e) };
}

/** P10.5 — mark the in-flight assistant message interrupted on abort. */
export async function markInterrupted(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  messageId: string,
): Promise<void> {
  await execute(registry, adapter, humanCtx, "chat.mark_message_interrupted", { messageId });
}

/** P16 — record the aggregated `ai_calls` row for the turn. */
export async function recordAiCall(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  args: {
    chatSessionId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    durationMs: number;
    succeeded: boolean;
    parentChatSessionId: string | null | undefined;
    parentAiCallId: string | null | undefined;
    requestId: string | null;
  },
): Promise<void> {
  await execute(registry, adapter, humanCtx, "chat.record_ai_call", args);
}
