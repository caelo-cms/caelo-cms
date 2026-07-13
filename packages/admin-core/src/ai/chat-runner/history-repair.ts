// SPDX-License-Identifier: MPL-2.0

/**
 * Run #10 D1 — tool_use/tool_result pairing repair for the provider
 * history.
 *
 * Anthropic rejects the whole call with HTTP 400 when the replayed
 * history contains either half of a broken pair:
 *
 *   - a `tool_result` whose id has no `tool_use` in a prior assistant
 *     message ("unexpected `tool_use_id` found in `tool_result`
 *     blocks") — run #10's live killer was the approval-ack message the
 *     Owner queue appended with the synthetic id `approval-<uuid>`;
 *   - a `tool_use` with no `tool_result` anywhere after it ("Tool
 *     result is missing for tool call …") — the same sessions
 *     accumulated these once the first 400 aborted a turn between
 *     persisting the assistant tool_calls and persisting their results.
 *
 * Both faults are PERMANENT once persisted: every later turn replays
 * the poisoned transcript and 400s, so the session is wedged with no
 * in-chat recovery. This module is the defense-in-depth half of the
 * fix (the injection half is the approval-ack no longer writing
 * tool-role messages): `buildProviderHistory` runs the repair on every
 * turn so already-poisoned sessions heal on their next message — same
 * posture as the empty-thinking-block filter.
 *
 * Pure and in-memory only: the persisted `chat_messages` transcript is
 * never modified; only what rides to the provider is repaired.
 */

import type { ChatMessageInput } from "../provider.js";

/** What the repair changed — callers log a breadcrumb when any list is non-empty. */
export interface HistoryRepairResult {
  messages: ChatMessageInput[];
  /** tool_result messages dropped because no assistant tool_use carries their id (or the id repeats). */
  droppedToolResultIds: string[];
  /** tool_use entries stripped from assistant messages because no tool_result answers them. */
  strippedToolCallIds: string[];
  /** Assistant messages dropped because stripping left them with no content at all. */
  droppedEmptyAssistantMessages: number;
}

/**
 * Drop orphan tool_results and strip unanswered tool_uses so every
 * surviving pair is complete. Duplicate tool_results for one id keep
 * only the first occurrence (a second one is the same 400 as an
 * orphan). Assistant messages left with no text, no tool calls, and no
 * thinking after stripping are dropped entirely — an empty assistant
 * content array is itself a provider-side rejection.
 */
export function repairToolCallPairing(messages: readonly ChatMessageInput[]): HistoryRepairResult {
  // Pass 1 — global id inventory. Results virtually always follow their
  // use, but the sets are order-independent on purpose: the repair must
  // never turn one wedged-session shape into another 400.
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const tc of m.toolCalls ?? []) toolUseIds.add(tc.id);
    } else if (m.role === "tool" && m.toolCallId) {
      toolResultIds.add(m.toolCallId);
    }
  }

  const out: ChatMessageInput[] = [];
  const droppedToolResultIds: string[] = [];
  const strippedToolCallIds: string[] = [];
  let droppedEmptyAssistantMessages = 0;
  const emittedResultIds = new Set<string>();

  for (const m of messages) {
    if (m.role === "tool") {
      const id = m.toolCallId ?? "";
      if (id.length === 0 || !toolUseIds.has(id) || emittedResultIds.has(id)) {
        droppedToolResultIds.push(id.length > 0 ? id : "(missing toolCallId)");
        continue;
      }
      emittedResultIds.add(id);
      out.push(m);
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const answered = m.toolCalls.filter((tc) => toolResultIds.has(tc.id));
      if (answered.length === m.toolCalls.length) {
        out.push(m);
        continue;
      }
      for (const tc of m.toolCalls) {
        if (!toolResultIds.has(tc.id)) strippedToolCallIds.push(tc.id);
      }
      const stillHasContent =
        m.content.length > 0 ||
        answered.length > 0 ||
        (m.thinkingBlocks !== undefined && m.thinkingBlocks.length > 0);
      if (!stillHasContent) {
        droppedEmptyAssistantMessages += 1;
        continue;
      }
      out.push({
        ...m,
        ...(answered.length > 0 ? { toolCalls: answered } : { toolCalls: undefined }),
      });
      continue;
    }
    out.push(m);
  }

  return {
    messages: out,
    droppedToolResultIds,
    strippedToolCallIds,
    droppedEmptyAssistantMessages,
  };
}
