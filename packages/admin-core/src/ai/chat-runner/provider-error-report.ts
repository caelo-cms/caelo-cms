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
 * a stderr line, never on the operator's `/settings/bugs` surface.
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

/** The tool_use / tool_result ids nested in one passthrough (Option-C) assembly, in order. */
function sdkPairIds(sdkMessages: readonly unknown[]): { uses: string[]; results: string[] } {
  const uses: string[] = [];
  const results: string[] = [];
  for (const msg of sdkMessages) {
    const content = (msg as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; toolCallId?: unknown } | null;
      if (typeof p?.toolCallId !== "string") continue;
      if (p.type === "tool-call") uses.push(p.toolCallId);
      else if (p.type === "tool-result" || p.type === "tool-error") results.push(p.toolCallId);
    }
  }
  return { uses, results };
}

/**
 * Render the replayed provider history to a compact, human-readable digest
 * that flags the exact tool_use/tool_result pairing faults the 400 is about.
 * Passthrough (Option-C `sdkMessages`) rows are unpacked too: most pairs span
 * a passthrough row (the call) and a reconstruction tool row (the result), so
 * an inventory that skipped them flagged every healthy result as an orphan and
 * hid the real fault — a result stored both inside an assembly and as a tool
 * row ("each tool_use must have a single result").
 */
export function summarizeHistoryForBugReport(messages: readonly ChatMessageInput[]): string {
  const rows = messages.map((m) => {
    const sdk = sdkPairIds(m.sdkMessages ?? []);
    const uses = [...(m.toolCalls ?? []).map((tc) => tc.id), ...sdk.uses];
    const results = [
      ...(m.role === "tool" && typeof m.toolCallId === "string" ? [m.toolCallId] : []),
      ...sdk.results,
    ];
    return { uses, results };
  });
  const toolUseIds = new Set(rows.flatMap((r) => r.uses));
  const toolResultIds = new Set(rows.flatMap((r) => r.results));
  const seenResultIds = new Set<string>();

  const lines = messages.map((m, i) => {
    const parts: string[] = [`#${i} ${m.role}`];
    if (Array.isArray(m.sdkMessages) && m.sdkMessages.length > 0) {
      parts.push(`sdk(${m.sdkMessages.length})`);
    }
    const { uses, results } = rows[i] ?? { uses: [], results: [] };
    if (uses.length > 0) {
      parts.push(
        `tool_use[${uses.map((id) => (toolResultIds.has(id) ? id : `${id}!UNANSWERED`)).join(",")}]`,
      );
    }
    for (const id of results) {
      let flag = "";
      if (!toolUseIds.has(id)) flag = "!ORPHAN";
      else if (seenResultIds.has(id)) flag = "!DUPLICATE";
      seenResultIds.add(id);
      parts.push(`tool_result(${id})${flag}`);
    }
    if (m.serverToolCalls && m.serverToolCalls.length > 0) {
      parts.push(`server_tool(${m.serverToolCalls.length})`);
    }
    return parts.join(" ");
  });

  const header =
    `Replayed provider history (${messages.length} messages). ` +
    `!UNANSWERED = a tool_use with no tool_result anywhere; ` +
    `!ORPHAN = a tool_result with no tool_use anywhere; ` +
    `!DUPLICATE = a second tool_result for the same tool_use. ` +
    `sdk(N) rows are SDK assemblies (Option C); their nested ids are listed.\n`;
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
    kind: "defect",
    source: "auto",
  }).catch(() => undefined);
}
