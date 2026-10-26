// SPDX-License-Identifier: MPL-2.0

/**
 * Session save/load + chat persistence wrappers for the chat-runner. Thin
 * helpers over the `chat.*` / `ai_memory.*` Query API ops; extracted verbatim
 * from the pre-split `chat-runner.ts`. No raw SQL — every call routes through
 * `execute(registry, adapter, ctx, op, args)`.
 */

import type { DatabaseAdapter, OperationRegistry, QueryError } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  type ChatChip,
  type ChatSendMessageInput,
  type ExecutionContext,
  PLUGIN_PREVIEW_REFERENCE_MARKER,
  parseListItemAttr,
} from "@caelo-cms/shared";

import { mcpAgentOpFields } from "../../ops/chat/mcp-agent.js";
import type { ProviderResponseMessage } from "../provider.js";
import type { AccumulatedServerToolCall, AccumulatedToolCall, ChatRunnerOptions } from "./types.js";

/** The session aggregate `chat.get_session` returns. */
export interface LoadedSession {
  session: {
    chatBranchId: string;
    /** When the chat began. Pins the `## Skills` index so a skill
     *  activated mid-chat is announced in the history instead of
     *  rewriting the cached system prefix (migration 0213). */
    createdAt: string;
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
    /**
     * Option C — the SDK-canonical ModelMessage assembly persisted for an
     * assistant turn. When present, replay hands these straight back to the
     * SDK instead of reconstructing from content/toolCalls/thinkingBlocks
     * (CLAUDE.md §12). Null on user/tool rows and legacy assistant rows.
     */
    responseMessages: unknown[] | null;
  }[];
}

/** Compose the persisted user-message body, inlining chip references. */
export function buildUserContent(input: ChatSendMessageInput): string {
  // content is optional as of Plan B (resume turns carry none) but this helper
  // is only reached on the operator-message path, where content is present.
  const content =
    (input.content ?? "") +
    (input.previewSelection
      ? PLUGIN_PREVIEW_REFERENCE_MARKER + JSON.stringify(input.previewSelection)
      : "");
  return input.chips.length > 0
    ? [
        content,
        "",
        "Element references attached to this message:",
        ...input.chips.map(chipLines),
      ].join("\n")
    : content;
}

/**
 * One reference as the AI reads it. The module id is the full uuid so the
 * AI can address the module in a tool call without a lookup (an 8-char
 * prefix fits no tool argument); quoted strings are JSON so a selection
 * with line breaks or quotes cannot bleed into the next line (#916).
 */
function chipLines(c: ChatChip): string {
  const element = c.selector ? `, element=${c.selector}` : "";
  // #917 — the placement field the text comes from, in the coordinates
  // set_page_module_content takes.
  const field =
    c.field && c.blockName !== undefined && c.position !== undefined
      ? `, placement=(blockName=${c.blockName}, position=${c.position}), field=${c.field}${c.item !== undefined ? `, entry=${c.item}${c.key ? `, key=${c.key}` : ""}` : ""}`
      : "";
  return [
    `  - ${c.label} (module=${c.moduleId}${element}${field}${listEntryRef(c.listItem)})`,
    ...(c.selectedText ? [`    selected text: ${JSON.stringify(c.selectedText)}`] : []),
    ...(c.context ? [`    surrounding text: ${JSON.stringify(c.context)}`] : []),
  ].join("\n");
}

/**
 * Epic #1107 — the list entry a reference sits in, in the coordinates the
 * list tools take: a shared list's id + entry id (read it with get_list,
 * change it with patch_list_items_many), or the content instance + list
 * field of a module's own list.
 */
function listEntryRef(attr: string | undefined): string {
  const e = attr ? parseListItemAttr(attr) : null;
  if (!e) return "";
  switch (e.kind) {
    case "shared":
      return `, list entry=(shared list=${e.listId}, entry=${e.itemId})`;
    case "instance":
      return `, list entry=(content instance=${e.contentInstanceId}, list field=${e.field}, entry=${e.itemId})`;
    case "local":
      return `, list entry=(default of list field=${e.field}, entry=${e.itemId})`;
  }
}

/** A decision the resume turn appends as an SDK tool-approval-response. */
export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

/**
 * Issue #658 — claim the decisions a resume turn applies
 * (`chat.claim_turn_approvals`), which appends them to the transcript as
 * tool-approval-response rows in the same transaction. The Live Edit chat
 * resumes only its own AI's paused turn, with the operator's click; a
 * caelo_chat call resumes only its own token's paused turn, with the
 * decisions the operator made on its cards. Each decision is claimed once.
 */
export async function claimTurnApprovals(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  options: Pick<ChatRunnerOptions, "agentRunSource" | "agentRunMcpAgent">,
  input: ChatSendMessageInput,
): Promise<{ ok: true; value: ApprovalDecision[] } | { ok: false; message: string }> {
  const fromExternalAgent = options.agentRunSource === "mcp_chat";
  if (fromExternalAgent !== (input.resumeDecidedApprovals === true)) {
    return {
      ok: false,
      message: fromExternalAgent
        ? "A caelo_chat turn resumes with the operator's recorded decisions (resumeDecidedApprovals), not a decision of its own."
        : "Only the external agent's own call resumes with recorded decisions; the chat resumes with the operator's click.",
    };
  }
  const r = await execute(registry, adapter, humanCtx, "chat.claim_turn_approvals", {
    chatSessionId: input.chatSessionId,
    ...(fromExternalAgent
      ? { source: "mcp_chat" as const, ...mcpAgentOpFields(options.agentRunMcpAgent) }
      : { source: "live_edit" as const, decision: input.resumeApproval }),
  });
  if (!r.ok) {
    return { ok: false, message: "message" in r.error ? String(r.error.message) : r.error.kind };
  }
  return { ok: true, value: (r.value as { decisions: ApprovalDecision[] }).decisions };
}

/**
 * Plan B (SDK approval gate) — persist approval decisions as ONE role='tool'
 * row carrying ONE SDK tool message with a tool-approval-response part per
 * decision (`responseMessages`). On the resume run the history replays it
 * verbatim after the paused assistant turn, so the SDK runs each approved
 * gated tool and lets the model react to each denial. One message for all of
 * them, because the SDK collects approval responses from the LAST message
 * only (#1074; same shape as `insertApprovalResponseRow` in
 * ops/chat/turn-approvals.ts).
 *
 * @returns the persisted content and messages, for the in-memory history,
 *   and whether the row was saved.
 */
export async function persistApprovalResponse(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  chatSessionId: string,
  decisions: readonly { approvalId: string; approved: boolean; reason?: string }[],
): Promise<{ saved: boolean; content: string; messages: ProviderResponseMessage[] }> {
  const messages: ProviderResponseMessage[] = [
    {
      role: "tool",
      content: decisions.map((d) => ({
        type: "tool-approval-response",
        approvalId: d.approvalId,
        approved: d.approved,
        ...(d.reason ? { reason: d.reason } : {}),
      })),
    },
  ];
  const content = decisions.map((d) => `[approval ${d.approved ? "granted" : "denied"}]`).join(" ");
  const save = await execute(registry, adapter, humanCtx, "chat.append_message", {
    chatSessionId,
    role: "tool",
    content,
    responseMessages: messages,
    source: "chat-runner approval response (persistApprovalResponse)",
  });
  return { saved: save.ok, content, messages };
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
    case "BranchNotFound":
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
    /** Option C — the SDK's canonical ModelMessage assembly for this turn. */
    responseMessages: unknown[] | null;
    status: "interrupted" | "complete";
  },
): Promise<{ ok: true; messageId: string } | { ok: false; sessionGone: boolean; message: string }> {
  const save = await execute(registry, adapter, humanCtx, "chat.append_message", {
    chatSessionId: args.chatSessionId,
    role: "assistant",
    content: args.content,
    toolCalls: args.toolCalls,
    thinkingBlocks: args.thinkingBlocks,
    responseMessages: args.responseMessages,
    status: args.status,
    // issue #303 — producer hint for the empty-content rejection.
    source: "chat-runner assistant turn (persistAssistantTurn)",
  });
  if (save.ok) return { ok: true, messageId: (save.value as { messageId: string }).messageId };
  const e = save.error;
  const sessionGone = e.kind === "HandlerError" && e.message.startsWith("session_gone");
  return { ok: false, sessionGone, message: describePersistError(e) };
}

/**
 * issue #442 — stamp the SDK's per-step `response.messages` slice onto an
 * already-persisted assistant anchor row. The anchor persists BEFORE the
 * step's tool dispatches (crash safety); the slice only exists after they
 * settle, so it lands in this second write. Returns false on failure — the
 * row then stays on the reconstruction replay lane (loud at the call site).
 */
export async function setResponseMessages(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  args: { messageId: string; responseMessages: readonly unknown[] },
): Promise<boolean> {
  const r = await execute(registry, adapter, humanCtx, "chat.set_response_messages", {
    messageId: args.messageId,
    responseMessages: args.responseMessages,
  });
  return r.ok;
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
    cacheCreationTokens: number;
    durationMs: number;
    succeeded: boolean;
    parentChatSessionId: string | null | undefined;
    parentAiCallId: string | null | undefined;
    requestId: string | null;
  },
): Promise<{ costMicrocents: number } | null> {
  const r = await execute(registry, adapter, humanCtx, "chat.record_ai_call", args);
  if (!r.ok) return null;
  return { costMicrocents: (r.value as { costMicrocents: number }).costMicrocents };
}
