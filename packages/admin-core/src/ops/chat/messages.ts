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
    })
    .strict(),
  output: messageRow,
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO chat_messages (
        chat_session_id, role, content, tool_calls, tool_call_id,
        tokens_in, tokens_out, cached_tokens
      )
      VALUES (
        ${input.chatSessionId}::uuid,
        ${input.role},
        ${input.content},
        ${input.toolCalls ? JSON.stringify(input.toolCalls) : null},
        ${input.toolCallId ?? null},
        ${input.tokensIn ?? null},
        ${input.tokensOut ?? null},
        ${input.cachedTokens ?? null}
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
