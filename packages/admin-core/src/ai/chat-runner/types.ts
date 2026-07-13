// SPDX-License-Identifier: MPL-2.0

/**
 * Shared types for the chat-runner modules. Extracted verbatim from the
 * pre-split `chat-runner.ts` so every sibling module imports its types from
 * here rather than from `index.ts` (avoids an import cycle through the
 * orchestrator).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";

import type { AIProvider } from "../provider.js";
import type { ToolRegistry } from "../tools/index.js";

export type ClientEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-start"; toolCallId: string; name: string; arguments: unknown }
  | { kind: "tool-result"; toolCallId: string; ok: boolean; content: string }
  | { kind: "tool-result-cached"; toolCallId: string }
  | { kind: "assistant-message-saved"; messageId: string }
  | { kind: "interrupted"; messageId: string | null }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
  | { kind: "done" }
  | { kind: "error"; message: string }
  /**
   * v0.5.9 — non-fatal observability signal. Surfaces conditions that
   * aren't errors but the operator likely wants to see. Distinct kind
   * so ChatPanel can render warnings differently from hard errors. Code
   * field lets future warnings differentiate.
   */
  | { kind: "warning"; code: string; message: string }
  /**
   * v0.2.54 — extended-thinking text deltas; ChatPanel renders into a
   * collapsed details block above the assistant message. UI can ignore
   * these when extended thinking is off.
   */
  | { kind: "thinking-delta"; text: string }
  /**
   * v0.2.54 — fired when one thinking content_block ends. Includes the
   * full block + its cryptographic signature for completeness; the UI
   * doesn't need to do anything with it (rendering uses thinking-delta
   * accumulation), but the runner uses it to persist + round-trip.
   */
  | { kind: "thinking-stop"; thinking: string; signature: string }
  /**
   * P10.5 #1 — wraps a child chat-runner's event when emitted from
   * inside a spawn_subagent / spawn_subagents tool dispatch. The UI
   * renders one collapsible card per role so the user sees the
   * subagent's progress live instead of a 5-30s frozen wait.
   */
  | {
      kind: "subagent-event";
      batchId: string;
      role: string;
      subagentChatSessionId: string;
      inner: Exclude<ClientEvent, { kind: "subagent-event" }>;
    };

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
  /**
   * P10.5 — names of tools to STRIP from the tool catalogue for THIS
   * invocation. The `spawn_subagent` tool handler passes
   * `{spawn_subagent, spawn_subagents}` when invoking runChatTurn for
   * the child — that's the depth cap, expressed as plain config. The
   * runner itself doesn't branch on "is this a subagent"; it just
   * filters its catalogue.
   */
  readonly excludedToolNames?: ReadonlySet<string>;
  /**
   * issue #264 — hard tool allowlist for THIS invocation, intersected
   * with the catalogue AFTER the engaged-skill allowlist. The
   * spawn_subagent handler passes the spec's `allowedToolNames` here
   * so a parent can narrow a subagent to (say) read-only tools. Unlike
   * a skill allowlist (misconfigured data → warn + fall back), a
   * zero-match here is a caller error the spawn handler rejects before
   * the child turn starts. Absent ⇒ no narrowing.
   */
  readonly allowedToolNames?: ReadonlySet<string>;
  /**
   * issue #264 — run this turn on ANOTHER chat's preview branch
   * instead of the session's own. spawn_subagent passes the parent
   * chat's branch so the subagent's reads see the orchestrator's
   * branched work (e.g. pages compose_from_import created on the
   * parent branch) and its writes/snapshots land on the branch the
   * operator will preview, publish, and undo. Without this, a
   * write-capable subagent works on an invisible branch nobody ever
   * merges (chat_sessions.chat_branch_id is UNIQUE per session, so
   * the child cannot simply share the row-level branch id). Absent
   * for normal turns: the session's own branch is used.
   */
  readonly chatBranchIdOverride?: string;
  /**
   * P10.5 #3 — soft cost cap per turn (microcents). After each
   * provider call's `usage` event, the loop checks accumulated cost;
   * if it exceeds this cap, the loop aborts with stopReason='error'
   * and emits an error event. spawn_subagent passes its spec's
   * maxCostMicrocents through here so the cap fires BEFORE the next
   * provider call instead of post-hoc.
   */
  readonly costCapMicrocents?: number;
  /**
   * v0.2.53 — Per-turn output ceiling. SSE handler reads this from
   * `getActiveProvider().maxOutputTokens` (set on `ai_providers.config`
   * at /security/ai). Falls back to `resolveMaxOutputTokensDefault(model)`
   * (32768 for adaptive-thinking models, 16384 otherwise — run #8 R1)
   * when the operator hasn't tuned it.
   */
  readonly maxOutputTokens?: number;
  /**
   * Per-turn sampling temperature. SSE handler reads this from
   * `getActiveProvider().temperature` (currently sourced from the
   * test-only `CAELO_CHAT_TEMPERATURE` env hook in provider-resolver).
   * Undefined ⇒ provider default (Anthropic ≈ 1.0). The
   * e2e-livedit suite pins `0` for determinism; production callers
   * pass nothing and behaviour is unchanged.
   */
  readonly temperature?: number;
}

/**
 * v0.10.17 — provider-side stop metadata forwarded by the adapter on the
 * `done` event. The empty-response detector logs these to explain why the
 * model returned empty (Anthropic stop_reason, SDK warnings, finishReason).
 */
export interface StoppingDiagnostics {
  rawFinishReason: string | null;
  warnings: unknown;
  providerMetadata: unknown;
  responseMessageId: string | null;
  responseModelId: string | null;
}

/**
 * A tool call accumulated from the provider stream. The shape the runner
 * threads from `streamProviderTurn` through persistence and `dispatchToolCall`;
 * structurally compatible with `ChatMessageInput["toolCalls"]`.
 */
export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** Loop terminal states tracked across the chat-runner turn. */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "error"
  | "max_loops"
  | "session_gone";

/**
 * Result shape of a single tool dispatch. Mirrors the subset of
 * `ToolResult` the runner consumes plus the v0.6.0 auto-recovery hints.
 */
export interface ToolDispatchResult {
  ok: boolean;
  content: string;
  image?: {
    base64: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  };
  // v0.6.0 W3 — propagated from ToolResult.nextAction so the
  // auto-recovery branch can inspect the structured recovery hint.
  nextAction?: {
    tool: string;
    args?: Record<string, unknown>;
    reason: string;
    autoExecute?: boolean;
    retryWithArgs?: { argName: string; fromValuePath: string };
  };
  // v0.6.0 alpha.2 — structured payload propagated from
  // ToolResult.value. Consumed by the W3 retry path to
  // extract a field at nextAction.retryWithArgs.fromValuePath.
  value?: unknown;
}

/**
 * The public `runChatTurn` signature, typed here so `tool-dispatch.ts` can
 * accept it as a parameter (for the spawn_subagent child-turn factory)
 * without importing `index.ts` — which would create an import cycle.
 */
export type RunChatTurnFn = (
  options: ChatRunnerOptions,
  input: ChatSendMessageInput,
) => AsyncIterable<ClientEvent>;
