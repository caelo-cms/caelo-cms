// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { type ProposeRemoveLocaleToolInput, proposeRemoveLocaleToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const proposeRemoveLocaleTool: ToolDefinitionWithHandler<ProposeRemoveLocaleToolInput> = {
  name: "propose_remove_locale",
  description:
    "Propose removing a locale from the site. " +
    "TWO-STEP: queues the change; approved on the chat's proposal card (queue: /security/locales/pending). " +
    "Do NOT claim the locale was removed. The proposal preview reports how many pages currently exist in that locale and how many redirects will be needed to avoid broken links — surface that count to the user. " +
    "The default locale cannot be removed; ask the Owner to set a different default first via `propose_set_default_locale`. " +
    "Removal at execute time fails if pages still exist in the locale; tell the user to delete or move those pages first.",
  schema: proposeRemoveLocaleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["code"],
    properties: {
      code: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "locales.propose_delete",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `propose_remove_locale failed: ${describeError(r.error)}` };
    }
    const { proposalId, preview } = r.value as { proposalId: string; preview: unknown };
    return {
      ok: true,
      content:
        `Queued proposal ${proposalId} to remove locale '${input.code}'. ` +
        `Preview: ${JSON.stringify(preview)}. ` +
        `Approve it on the proposal card in this chat (queue: /security/locales/pending).`,
    };
  },
};
