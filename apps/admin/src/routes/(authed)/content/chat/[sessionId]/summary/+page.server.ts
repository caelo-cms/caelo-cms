// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.20 — per-chat completion view.
 *
 * Renders chat.summarize output: total/success/failure counts, per-tool
 * breakdown, sample failures. Same permission gate as the main chat
 * route.
 */

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

interface ToolBreakdown {
  name: string;
  ok: number;
  failed: number;
  failures: { messageId: string; content: string; createdAt: string }[];
}

interface SummaryData {
  chatSessionId: string;
  title: string | null;
  totalToolCalls: number;
  successCount: number;
  failureCount: number;
  byTool: ToolBreakdown[];
  loopCount: number;
  durationMs: number | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "chat.summarize", {
    chatSessionId: params.sessionId,
  });
  if (!r.ok) throw error(404, "Chat not found or summary unavailable");
  return { summary: r.value as SummaryData };
};
