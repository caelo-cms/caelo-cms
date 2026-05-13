// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: stage_change. Marks a single pending change as
 * ready-to-publish (`stage_state='staged'` on the entity's
 * chat_branch_publish_marks row).
 *
 * Per CMS_REQUIREMENTS — Caelo's three-state staging flow is
 * AI-proposes / human-disposes. The AI may stage individual edits
 * (helpful when a multi-step turn produced several edits and only
 * some are ready to ship now), but NEVER publishes. There is no
 * `publish_staged` AI tool by design — the Publish button is the
 * human's confirmation.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const stageChangeInput = z
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

type StageChangeInput = z.infer<typeof stageChangeInput>;

export const stageChangeTool: ToolDefinitionWithHandler<StageChangeInput> = {
  name: "stage_change",
  description:
    "Mark a single pending change as ready-to-publish. " +
    "The user still has to click Publish in the chat panel to apply it to the live site. " +
    "Use this only when you've made several edits and want to flag some as ready while leaving others pending. " +
    "DO NOT call this for every edit — most flows let the user stage manually from the chat panel. " +
    "DO NOT claim the change is live — staging is the step BEFORE publishing.",
  schema: stageChangeInput,
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
        content: "stage_change requires an active chat session; called from outside a chat-runner",
      };
    }
    const result = await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.stage", {
      chatSessionId: toolCtx.chatSessionId,
      entities: [{ kind: input.entityKind, entityId: input.entityId }],
    });
    if (result.ok) {
      const v = result.value as { staged: number };
      return {
        ok: true,
        content:
          v.staged > 0
            ? `staged ${input.entityKind} ${input.entityId} — tell the user to click Publish in the chat panel`
            : `no pending snapshot for ${input.entityKind} ${input.entityId} (already staged or not edited in this chat)`,
      };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};
