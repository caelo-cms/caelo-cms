// SPDX-License-Identifier: MPL-2.0

/**
 * Low-level chat message ops. The streaming orchestration lives in
 * `ai/chat-runner.ts` — these ops are just typed Postgres writes the
 * runner calls between provider events. Each one is its own tx so the
 * provider stream can land message-by-message.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const messageRow = z.object({ messageId: z.string() });

export const appendChatMessageOp = defineOperation({
  name: "chat.append_message",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      role: z.enum(["user", "assistant", "tool"]),
      content: z.string(),
      toolCalls: z.array(z.unknown()).nullable().optional(),
      toolCallId: z.string().nullable().optional(),
      tokensIn: z.number().int().nullable().optional(),
      tokensOut: z.number().int().nullable().optional(),
      cachedTokens: z.number().int().nullable().optional(),
      status: z.enum(["complete", "interrupted"]).optional(),
    })
    .strict(),
  output: messageRow,
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO chat_messages (
        chat_session_id, role, content, tool_calls, tool_call_id,
        tokens_in, tokens_out, cached_tokens, status
      )
      VALUES (
        ${input.chatSessionId}::uuid,
        ${input.role},
        ${input.content},
        ${input.toolCalls ? JSON.stringify(input.toolCalls) : null},
        ${input.toolCallId ?? null},
        ${input.tokensIn ?? null},
        ${input.tokensOut ?? null},
        ${input.cachedTokens ?? null},
        ${input.status ?? "complete"}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "chat.append_message",
        message: "no id returned",
      });
    }
    await tx.execute(sql`
      UPDATE chat_sessions SET last_active_at = now()
      WHERE id = ${input.chatSessionId}::uuid
    `);
    return ok({ messageId: id });
  },
});

/**
 * Mark an existing assistant message as interrupted (P5.2 #2). Called by
 * the chat-runner when the SSE request aborts mid-stream so the UI can
 * render an "interrupted" badge instead of a silently truncated reply.
 */
export const markChatMessageInterruptedOp = defineOperation({
  name: "chat.mark_message_interrupted",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ messageId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE chat_messages SET status = 'interrupted'
      WHERE id = ${input.messageId}::uuid
    `);
    return ok({});
  },
});

/**
 * P5.2 #3 — tool-call dedup. Cache the result of a tool dispatch keyed
 * by (chat_session_id, tool_call_id). The runner consults this before
 * executing the tool; second invocation returns the cached row.
 */
export const cacheToolResultOp = defineOperation({
  name: "chat.cache_tool_result",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      toolCallId: z.string(),
      toolName: z.string(),
      ok: z.boolean(),
      content: z.string(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO chat_tool_results (chat_session_id, tool_call_id, tool_name, result_ok, result_content)
      VALUES (${input.chatSessionId}::uuid, ${input.toolCallId}, ${input.toolName}, ${input.ok}, ${input.content})
      ON CONFLICT (chat_session_id, tool_call_id) DO NOTHING
    `);
    return ok({});
  },
});

export const lookupToolResultOp = defineOperation({
  name: "chat.lookup_tool_result",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      toolCallId: z.string(),
    })
    .strict(),
  output: z.object({
    cached: z.object({ toolName: z.string(), ok: z.boolean(), content: z.string() }).nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT tool_name, result_ok, result_content
      FROM chat_tool_results
      WHERE chat_session_id = ${input.chatSessionId}::uuid AND tool_call_id = ${input.toolCallId}
      LIMIT 1
    `)) as unknown as { tool_name: string; result_ok: boolean; result_content: string }[];
    const r = rows[0];
    return ok({
      cached: r ? { toolName: r.tool_name, ok: r.result_ok, content: r.result_content } : null,
    });
  },
});

export const recordAiCallOp = defineOperation({
  name: "chat.record_ai_call",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid().nullable().optional(),
      provider: z.string(),
      model: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedTokens: z.number().int().nonnegative().default(0),
      costEstimateMicrocents: z.number().int().nonnegative().default(0),
      durationMs: z.number().int().nonnegative().default(0),
      succeeded: z.boolean().default(true),
    })
    .strict(),
  output: z.object({ aiCallId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO ai_calls (
        chat_session_id, actor_id, provider, model,
        input_tokens, output_tokens, cached_tokens,
        cost_estimate_microcents, duration_ms, succeeded
      ) VALUES (
        ${input.chatSessionId ?? null},
        ${ctx.actorId}::uuid,
        ${input.provider},
        ${input.model},
        ${input.inputTokens},
        ${input.outputTokens},
        ${input.cachedTokens},
        ${input.costEstimateMicrocents}::bigint,
        ${input.durationMs},
        ${input.succeeded}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "chat.record_ai_call",
        message: "no id returned",
      });
    }
    return ok({ aiCallId: id });
  },
});
