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
 * wrongly dropped. Provider-executed calls (Anthropic tool search) are
 * tracked separately: their pairing lives entirely INSIDE the assemblies
 * (the API pairs them; no tool-role row ever answers one), and a dangling
 * one is the issue-#442 session-wedging poison the strip below heals.
 * Defensive: `ProviderResponseMessage` is `unknown`, so we only read the
 * SDK's documented `{ content: [{ type, toolCallId }] }` shape.
 */
function harvestSdkPairIds(
  sdkMessages: readonly unknown[],
  toolUseIds: Set<string>,
  toolResultIds: Set<string>,
  providerExecutedCallIds: Set<string>,
): void {
  for (const msg of sdkMessages) {
    if (msg === null || typeof msg !== "object") continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as { type?: unknown; toolCallId?: unknown; providerExecuted?: unknown };
      if (typeof p.toolCallId !== "string") continue;
      if (p.type === "tool-call") {
        toolUseIds.add(p.toolCallId);
        if (p.providerExecuted === true) providerExecutedCallIds.add(p.toolCallId);
      } else if (p.type === "tool-result") toolResultIds.add(p.toolCallId);
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
  /**
   * issue #442 (unwedge) — providerExecuted (tool-search) calls stripped
   * from INSIDE passthrough assemblies because no result answers them
   * anywhere in the history. A dangling one is poison: the provider rejects
   * every replay carrying it ("server_tool_use … without a corresponding
   * tool_search_tool_result block"), permanently wedging the session.
   * Non-empty means a poisoned session was HEALED this turn — callers must
   * surface that loudly (bug-report row), never silently.
   */
  strippedServerToolCallIds: string[];
}

/**
 * issue #442 (unwedge) — rewrite one passthrough assembly with its dangling
 * providerExecuted tool-calls removed. Deterministic and byte-stable across
 * turns (the stored row is immutable, so the strip yields identical output
 * every replay — no prompt-cache churn). Messages left with empty content
 * are dropped (an empty assistant message is itself a provider rejection).
 */
function stripDanglingServerCalls(
  sdkMessages: readonly unknown[],
  danglingIds: ReadonlySet<string>,
): unknown[] {
  const out: unknown[] = [];
  for (const msg of sdkMessages) {
    if (msg === null || typeof msg !== "object") {
      out.push(msg);
      continue;
    }
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      out.push(msg);
      continue;
    }
    const kept = content.filter((part) => {
      if (part === null || typeof part !== "object") return true;
      const p = part as { type?: unknown; toolCallId?: unknown; providerExecuted?: unknown };
      return !(
        p.type === "tool-call" &&
        p.providerExecuted === true &&
        typeof p.toolCallId === "string" &&
        danglingIds.has(p.toolCallId)
      );
    });
    if (kept.length === content.length) {
      out.push(msg);
    } else if (kept.length > 0) {
      out.push({ ...(msg as Record<string, unknown>), content: kept });
    }
    // kept.length === 0 → drop the whole message.
  }
  return out;
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
 * passthrough assistant tool_use ↔ reconstruction tool-role result), and the
 * passthrough rows replay verbatim with ONE exception — issue #442's
 * unwedge: a providerExecuted (tool-search) call whose result exists NOWHERE
 * in the history is stripped from inside the assembly. That dangling call is
 * the deferred-result poison that permanently wedged session 57c2f0f5
 * (Anthropic rejects every replay carrying it); post-#442 the SDK loop
 * consumes deferred continuations in-turn, so any persisted dangling call is
 * either pre-migration poison or an interrupted turn's residue — both
 * correctly healed here. Callers surface a heal loudly via
 * `strippedServerToolCallIds` (bug-report row), never silently.
 */
export function repairToolCallPairing(messages: readonly ChatMessageInput[]): HistoryRepairResult {
  // Pass 1 — global id inventory. Results virtually always follow their
  // use, but the sets are order-independent on purpose: the repair must
  // never turn one wedged-session shape into another 400.
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  const providerExecutedCallIds = new Set<string>();
  for (const m of messages) {
    // Passthrough rows are opaque + SDK-paired: harvest their nested ids into
    // the inventory (so cross-row pairs survive) but never strip/modify them —
    // EXCEPT the issue-#442 dangling providerExecuted calls (below).
    if (isPassthroughRow(m)) {
      harvestSdkPairIds(m.sdkMessages ?? [], toolUseIds, toolResultIds, providerExecutedCallIds);
    } else if (m.role === "assistant") {
      for (const tc of m.toolCalls ?? []) toolUseIds.add(tc.id);
    } else if (m.role === "tool" && m.toolCallId) {
      toolResultIds.add(m.toolCallId);
    }
  }

  // issue #442 (unwedge) — providerExecuted calls with NO result anywhere in
  // the history. GLOBAL inventory on purpose: under the SDK loop a healthy
  // deferred pair spans TWO rows (the call in step N's slice, the deferred
  // result in step N+1's), so a per-row check would strip healthy history.
  // A call unmatched across the WHOLE history is unconsumable poison — the
  // deferred-resume tolerance the API grants at the in-turn boundary never
  // applies to a replay that has since grown more turns.
  const danglingServerCallIds = new Set(
    [...providerExecutedCallIds].filter((id) => !toolResultIds.has(id)),
  );

  const out: ChatMessageInput[] = [];
  const droppedToolResultIds: string[] = [];
  const strippedToolCallIds: string[] = [];
  const strippedServerToolCallIds: string[] = [];
  let droppedEmptyAssistantMessages = 0;
  const emittedResultIds = new Set<string>();

  for (const m of messages) {
    // Passthrough rows replay verbatim — opaque + already correctly paired —
    // except that a dangling providerExecuted call nested inside is stripped
    // (the issue-#442 heal; deterministic + byte-stable, see the helper).
    if (isPassthroughRow(m)) {
      const sdkMessages = m.sdkMessages ?? [];
      const rowDangling = new Set<string>();
      harvestSdkPairIds(sdkMessages, new Set(), new Set(), rowDangling);
      const toStrip = [...rowDangling].filter((id) => danglingServerCallIds.has(id));
      if (toStrip.length === 0) {
        out.push(m);
        continue;
      }
      strippedServerToolCallIds.push(...toStrip);
      const healed = stripDanglingServerCalls(sdkMessages, danglingServerCallIds);
      if (healed.length > 0) {
        out.push({ ...m, sdkMessages: healed });
      } else {
        droppedEmptyAssistantMessages += 1;
      }
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
    strippedServerToolCallIds,
  };
}
