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
import { lookupPricing } from "../../ai/pricing-cache.js";

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
      /** P10.5 — parent attribution for subagent invocations. */
      parentChatSessionId: z.string().uuid().nullable().optional(),
      parentAiCallId: z.string().uuid().nullable().optional(),
      /** P11.6 — plugin attribution for ctx.ai.complete dispatches. */
      pluginId: z.string().uuid().nullable().optional(),
      /** P16 — image vs text op kind. Default 'text' so existing
       *  callers (chat-runner) don't need to set it. */
      operationType: z.enum(["text", "image"]).default("text"),
      /** P16 — number of images generated (only meaningful when
       *  operationType='image'; ignored otherwise). */
      imageCount: z.number().int().nonnegative().default(0),
      /** P16 — correlates with structured-log entries + audit_events. */
      requestId: z.string().max(64).nullable().optional(),
    })
    .strict(),
  output: z.object({ aiCallId: z.string() }),
  handler: async (ctx, input, tx) => {
    // P16 — when caller doesn't pre-compute cost, look it up from the
    // ai_pricing table. Centralizing here means callers (chat-runner,
    // generate_image, future ctx.ai.complete) don't need to know rates.
    // Caller-supplied non-zero costs win (allows out-of-band overrides;
    // also keeps existing tests with explicit costs untouched).
    let costMicrocents = input.costEstimateMicrocents;
    if (costMicrocents === 0) {
      // P16 hardening — pricing-table lookup goes through the in-process
      // LRU (60s TTL, LISTEN/NOTIFY-invalidated). Same fallback logic:
      // exact (provider, model) wins over provider-wildcard `*`.
      const p = await lookupPricing(tx, input.provider, input.model, input.operationType);
      if (p) {
        if (input.operationType === "image") {
          costMicrocents = p.inputMicrocents * input.imageCount;
        } else {
          const inRate = p.inputMicrocents;
          const outRate = p.outputMicrocents ?? 0;
          const cacheRate = p.cachedMicrocents ?? inRate;
          const billedInput = Math.max(0, input.inputTokens - input.cachedTokens);
          costMicrocents = Math.round(
            (billedInput * inRate) / 1000 +
              (input.cachedTokens * cacheRate) / 1000 +
              (input.outputTokens * outRate) / 1000,
          );
        }
      }
    }
    const rows = (await tx.execute(sql`
      INSERT INTO ai_calls (
        chat_session_id, actor_id, provider, model,
        input_tokens, output_tokens, cached_tokens,
        cost_estimate_microcents, duration_ms, succeeded,
        parent_chat_session_id, parent_ai_call_id,
        plugin_id, operation_type, image_count, request_id
      ) VALUES (
        ${input.chatSessionId ?? null},
        ${ctx.actorId}::uuid,
        ${input.provider},
        ${input.model},
        ${input.inputTokens},
        ${input.outputTokens},
        ${input.cachedTokens},
        ${costMicrocents}::bigint,
        ${input.durationMs},
        ${input.succeeded},
        ${input.parentChatSessionId ?? null},
        ${input.parentAiCallId ?? null},
        ${input.pluginId ?? null},
        ${input.operationType},
        ${input.imageCount},
        ${input.requestId ?? null}
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
