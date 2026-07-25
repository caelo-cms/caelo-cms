// SPDX-License-Identifier: MPL-2.0

/**
 * Turn-fatal provider errors → the `ai_bug_reports` channel.
 *
 * Auto bug-capture used to fire in ONE place — a failed tool RESULT
 * (tool-dispatch.ts) — so a turn that died on the provider call itself
 * (before/without any tool running) filed nothing. The class that motivated
 * this: a replayed history carrying a `tool_use` with no paired `tool_result`,
 * which Anthropic 400s (`messages.N: tool_use ids were found without
 * tool_result blocks …`). It surfaced only as a transient SSE `error` event +
 * a stderr line, never on the operator's `/security/bugs` surface.
 *
 * This module files those into `ai_bug_reports` with `source:'auto'` +
 * `severity:'blocking'` and, crucially, a serialized digest of the offending
 * replayed history so the row pinpoints the dangling pair. Best-effort: a
 * failing report write must never sink the turn (mirrors tool-dispatch.ts).
 * The op dedups auto rows per session on (source, chat_session_id,
 * suspected_tool, what_happened), so retries of the same error collapse to one.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import type { ChatMessageInput } from "../provider.js";

/**
 * Render the replayed provider history to a compact, human-readable digest
 * that flags the exact tool_use/tool_result pairing faults the 400 is about.
 * Passthrough (Option-C `sdkMessages`) rows carry their pairs inside an opaque
 * SDK assembly we don't unpack here — they're shown as `sdk(N)` so the reader
 * knows those rows are self-paired; only OUR reconstruction rows are flag-able.
 */
export function summarizeHistoryForBugReport(messages: readonly ChatMessageInput[]): string {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) toolUseIds.add(tc.id);
    if (m.role === "tool" && typeof m.toolCallId === "string") toolResultIds.add(m.toolCallId);
  }

  const lines = messages.map((m, i) => {
    const parts: string[] = [`#${i} ${m.role}`];
    if (Array.isArray(m.sdkMessages) && m.sdkMessages.length > 0) {
      parts.push(`sdk(${m.sdkMessages.length})`);
    }
    const uses = (m.toolCalls ?? []).map((tc) => tc.id);
    if (uses.length > 0) {
      parts.push(
        `tool_use[${uses.map((id) => (toolResultIds.has(id) ? id : `${id}!UNANSWERED`)).join(",")}]`,
      );
    }
    if (m.role === "tool" && typeof m.toolCallId === "string") {
      parts.push(
        toolUseIds.has(m.toolCallId)
          ? `tool_result(${m.toolCallId})`
          : `tool_result(${m.toolCallId})!ORPHAN`,
      );
    }
    if (m.serverToolCalls && m.serverToolCalls.length > 0) {
      parts.push(`server_tool(${m.serverToolCalls.length})`);
    }
    return parts.join(" ");
  });

  const header =
    `Replayed provider history (${messages.length} messages). ` +
    `!UNANSWERED = a tool_use with no following tool_result; ` +
    `!ORPHAN = a tool_result with no prior tool_use. ` +
    `sdk(N) rows are SDK-paired (Option C) and not flag-able here.\n`;
  return (header + lines.join("\n")).slice(0, 7900);
}

/**
 * File a turn-fatal provider error into `ai_bug_reports`. Best-effort — never
 * throws (a broken bug channel must not sink the turn). `providerMessage` is
 * the raw provider error / operator notice; `messages` is the history that was
 * replayed on the failing call.
 */
export async function fileTurnFatalProviderReport(args: {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  ctx: ExecutionContext;
  chatSessionId: string;
  providerMessage: string;
  messages: readonly ChatMessageInput[];
}): Promise<void> {
  await execute(args.registry, args.adapter, args.ctx, "ai_bug_reports.create", {
    chatSessionId: args.chatSessionId,
    title: "AI turn failed: provider error",
    whatHappened: (
      args.providerMessage.trim() || "The AI provider rejected or failed the request."
    ).slice(0, 4000),
    expected:
      "The provider should accept the replayed conversation and stream a response. A turn-fatal " +
      "provider error means the request Caelo built was rejected (e.g. a tool_use with no paired " +
      "tool_result in the replayed history) or the upstream failed.",
    suspectedTool: null,
    evidence: summarizeHistoryForBugReport(args.messages),
    severity: "blocking",
    source: "auto",
  }).catch(() => undefined);
}
