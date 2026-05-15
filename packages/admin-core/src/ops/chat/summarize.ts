// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.20 — `chat.summarize`. Per-chat completion view: counts every
 * tool call grouped by tool name + ok/failed status, with the first
 * 5 failure messages per tool for quick scanning.
 *
 * Why this op exists: Cloud Run logs only carry per-loop summaries
 * (loopStop, toolCalls, token counts). The Owner can't tell from
 * logs alone which specific tool calls failed without opening the
 * chat transcript and scrolling. This op derives the same data from
 * `chat_messages` (no schema change, no new audit join required) and
 * powers the `/content/chat/[sessionId]/summary` page.
 *
 * Failure detection: a tool result is a failure when its content
 * starts with "<op_name> failed:", "Tool call failed:", "invalid
 * arguments", or "validation failed". Same heuristic the ChatPanel
 * uses for the "failed only" filter.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const failureSample = z
  .object({
    messageId: z.string(),
    content: z.string(),
    createdAt: z.string(),
  })
  .strict();

const toolBreakdown = z
  .object({
    name: z.string(),
    ok: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failures: z.array(failureSample),
  })
  .strict();

const summaryOutput = z
  .object({
    chatSessionId: z.string(),
    title: z.string().nullable(),
    totalToolCalls: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    byTool: z.array(toolBreakdown),
    loopCount: z.number().int().nonnegative(),
    durationMs: z.number().int().nullable(),
    firstMessageAt: z.string().nullable(),
    lastMessageAt: z.string().nullable(),
  })
  .strict();

function isFailedToolContent(content: string): boolean {
  if (!content) return false;
  if (/^Tool call failed:/i.test(content)) return true;
  if (/^[a-z][a-z0-9_.]*\s+failed:/i.test(content)) return true;
  if (/^invalid arguments\b/i.test(content)) return true;
  if (/^validation failed\b/i.test(content)) return true;
  return false;
}

interface RawMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: unknown;
  tool_call_id: string | null;
  created_at: string | Date;
}

interface ToolCallRef {
  id: string;
  name: string;
}

export const summarizeChatOp = defineOperation({
  name: "chat.summarize",
  // Read-only; same scope as chat.get_session.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: summaryOutput,
  handler: async (_ctx, input, tx) => {
    const sessionRows = (await tx.execute(sql`
      SELECT id::text AS id, title FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid LIMIT 1
    `)) as unknown as { id: string; title: string | null }[];
    const session = sessionRows[0];
    if (!session) {
      return err({
        kind: "HandlerError",
        operation: "chat.summarize",
        message: "session not found",
      });
    }
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, role, content, tool_calls, tool_call_id, created_at
      FROM chat_messages
      WHERE chat_session_id = ${input.chatSessionId}::uuid
      ORDER BY created_at ASC
    `)) as unknown as RawMessage[];

    // Build tool_call_id → tool_name lookup from assistant messages.
    const toolNameById = new Map<string, string>();
    let loopCount = 0;
    for (const m of rows) {
      if (m.role === "assistant") {
        loopCount += 1;
        const calls = m.tool_calls;
        const parsed = typeof calls === "string" ? JSON.parse(calls) : calls;
        if (Array.isArray(parsed)) {
          for (const c of parsed as ToolCallRef[]) {
            if (c && typeof c.id === "string" && typeof c.name === "string") {
              toolNameById.set(c.id, c.name);
            }
          }
        }
      }
    }

    interface BucketState {
      ok: number;
      failed: number;
      failures: { messageId: string; content: string; createdAt: string }[];
    }
    const buckets = new Map<string, BucketState>();
    let totalToolCalls = 0;
    let successCount = 0;
    let failureCount = 0;
    for (const m of rows) {
      if (m.role !== "tool") continue;
      totalToolCalls += 1;
      const name = (m.tool_call_id && toolNameById.get(m.tool_call_id)) || "(unknown)";
      const failed = isFailedToolContent(m.content);
      let bucket = buckets.get(name);
      if (!bucket) {
        bucket = { ok: 0, failed: 0, failures: [] };
        buckets.set(name, bucket);
      }
      if (failed) {
        bucket.failed += 1;
        failureCount += 1;
        if (bucket.failures.length < 5) {
          bucket.failures.push({
            messageId: m.id,
            content: m.content.slice(0, 500),
            createdAt:
              m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
          });
        }
      } else {
        bucket.ok += 1;
        successCount += 1;
      }
    }

    const firstAt = rows[0]?.created_at;
    const lastAt = rows.length > 0 ? rows[rows.length - 1]?.created_at : null;
    const firstMessageAt = firstAt
      ? firstAt instanceof Date
        ? firstAt.toISOString()
        : String(firstAt)
      : null;
    const lastMessageAt = lastAt
      ? lastAt instanceof Date
        ? lastAt.toISOString()
        : String(lastAt)
      : null;
    const durationMs =
      firstMessageAt && lastMessageAt
        ? new Date(lastMessageAt).getTime() - new Date(firstMessageAt).getTime()
        : null;

    const byTool = [...buckets.entries()]
      .map(([name, b]) => ({ name, ok: b.ok, failed: b.failed, failures: b.failures }))
      .sort((a, b) => b.failed - a.failed || b.ok - a.ok || a.name.localeCompare(b.name));

    return ok({
      chatSessionId: input.chatSessionId,
      title: session.title,
      totalToolCalls,
      successCount,
      failureCount,
      byTool,
      loopCount,
      durationMs,
      firstMessageAt,
      lastMessageAt,
    });
  },
});
