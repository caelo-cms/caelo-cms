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

/**
 * A passthrough row (Option C) carries the SDK's opaque ModelMessage assembly
 * in `sdkMessages`; its tool_use/tool_result pairs live nested inside and are
 * correct by construction. `buildProviderHistory` pushes these as
 * `{ role, content, sdkMessages }` with no top-level `toolCalls`/`toolCallId`.
 */
function isPassthroughRow(m: ChatMessageInput): boolean {
  return Array.isArray(m.sdkMessages) && m.sdkMessages.length > 0;
}

/**
 * Harvest the tool_use / tool_result ids nested inside a passthrough row's
 * opaque SDK assembly so the pairing inventory sees them too. Without this, a
 * reconstruction tool_result answering a passthrough tool_use (the NORMAL
 * Option-C shape: passthrough assistant emits the tool_use, the result is a
 * separate reconstruction tool-role row) would look like an orphan and be
 * wrongly dropped. Defensive: `ProviderResponseMessage` is `unknown`, so we
 * only read the SDK's documented `{ content: [{ type, toolCallId }] }` shape.
 */
function harvestSdkPairIds(
  sdkMessages: readonly unknown[],
  toolUseIds: Set<string>,
  toolResultIds: Set<string>,
): void {
  for (const msg of sdkMessages) {
    if (msg === null || typeof msg !== "object") continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as { type?: unknown; toolCallId?: unknown };
      if (typeof p.toolCallId !== "string") continue;
      if (p.type === "tool-call") toolUseIds.add(p.toolCallId);
      else if (p.type === "tool-result") toolResultIds.add(p.toolCallId);
    }
  }
}

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
 * orphan). Assistant messages left with no text and no surviving tool
 * calls after stripping are dropped entirely — an assistant turn that is
 * empty OR carries only orphaned thinking blocks is itself a
 * provider-side rejection.
 *
 * Passthrough (Option-C `sdkMessages`) rows are treated as opaque,
 * already-paired units: their nested ids feed the inventory so a
 * reconstruction row can pair ACROSS a passthrough row (the normal shape:
 * passthrough assistant tool_use ↔ reconstruction tool-role result), but the
 * passthrough rows themselves are replayed verbatim, never stripped. This is
 * what lets the repair run over a mixed history — the interrupt hole where an
 * aborted turn persisted a `tool_use` with no `tool_result` while earlier
 * turns carried passthrough rows (which previously forced the whole repair to
 * be skipped, so the orphan survived into the replay and 400'd).
 */
export function repairToolCallPairing(messages: readonly ChatMessageInput[]): HistoryRepairResult {
  // Pass 1 — global id inventory. Results virtually always follow their
  // use, but the sets are order-independent on purpose: the repair must
  // never turn one wedged-session shape into another 400.
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    // Passthrough rows are opaque + SDK-paired: harvest their nested ids into
    // the inventory (so cross-row pairs survive) but never strip/modify them.
    if (isPassthroughRow(m)) {
      harvestSdkPairIds(m.sdkMessages ?? [], toolUseIds, toolResultIds);
    } else if (m.role === "assistant") {
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
    // Passthrough rows replay verbatim — opaque + already correctly paired.
    if (isPassthroughRow(m)) {
      out.push(m);
      continue;
    }
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
      // Thinking blocks do NOT count as surviving content here: an
      // assistant message left with ONLY thinking after its tool_use is
      // stripped is itself a provider-side 400 (Anthropic requires a
      // thinking block to lead into a text/tool_use response or be the
      // final turn — a bare thinking-only turn mid-conversation is
      // rejected). Those blocks are also orphaned: their signature signed
      // the now-removed tool_use, so replaying them buys nothing. Dropping
      // the whole message is what lets a thinking-enabled session that was
      // bricked by a dangling tool_use (the `max_tokens`-after-tool_use
      // wedge) heal on its next load, not just a thinking-off one.
      const stillHasContent = m.content.length > 0 || answered.length > 0;
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
