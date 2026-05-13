// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: unstage_change. Demotes a staged change back to pending
 * (`stage_state='pending'`). Useful when the AI realises a previously
 * staged edit needs further work before publish.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const unstageChangeInput = z
  .object({
    entityKind: z.enum([
      "module",
      "template",
      "page",
      "pageLayout",
      "pageModuleContent",
      "structuredSet",
    ]),
    entityId: z.string().uuid(),
  })
  .strict();

type UnstageChangeInput = z.infer<typeof unstageChangeInput>;

export const unstageChangeTool: ToolDefinitionWithHandler<UnstageChangeInput> = {
  name: "unstage_change",
  description:
    "Demote a staged change back to pending. " +
    "Use when an edit you previously staged needs more work before it's ready for publish. " +
    "The user can still stage it again via the chat panel.",
  schema: unstageChangeInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["entityKind", "entityId"],
    properties: {
      entityKind: {
        type: "string",
        enum: ["module", "template", "page", "pageLayout", "pageModuleContent", "structuredSet"],
      },
      entityId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    if (!toolCtx.chatSessionId) {
      return {
        ok: false,
        content:
          "unstage_change requires an active chat session; called from outside a chat-runner",
      };
    }
    const result = await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.unstage", {
      chatSessionId: toolCtx.chatSessionId,
      entities: [{ kind: input.entityKind, entityId: input.entityId }],
    });
    if (result.ok) {
      const v = result.value as { unstaged: number };
      return {
        ok: true,
        content:
          v.unstaged > 0
            ? `unstaged ${input.entityKind} ${input.entityId} — it's back to pending`
            : `no staged snapshot for ${input.entityKind} ${input.entityId}`,
      };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};
