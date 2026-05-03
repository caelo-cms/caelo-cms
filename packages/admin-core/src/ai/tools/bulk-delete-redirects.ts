// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — `bulk_delete_redirects`. Three input
 * shapes: explicit ids, explicit fromPaths, or a substring `matches`
 * pattern. Exactly one of the three. Single tx.
 */

import { execute } from "@caelo-cms/query-api";
import { bulkDeleteRedirectsToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const bulkDeleteRedirectsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BulkDeleteRedirectsToolInput
> = {
  name: "bulk_delete_redirects",
  description:
    "Delete redirects in one tx by id list, fromPath list, or substring match. Provide EXACTLY ONE of " +
    "`redirectIds`, `fromPaths`, `matches`. " +
    "Always run `find_redirects` FIRST to preview what will be removed; surface the count to the user " +
    "before calling this. " +
    "Don't use for a single deletion — use `redirects.delete` instead.",
  schema: bulkDeleteRedirectsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      redirectIds: {
        type: "array",
        maxItems: 500,
        items: { type: "string", format: "uuid" },
      },
      fromPaths: {
        type: "array",
        maxItems: 500,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
      matches: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.delete_many", input);
    if (!r.ok) {
      return { ok: false, content: `redirects.delete_many failed: ${describeError(r.error)}` };
    }
    return {
      ok: true,
      content: `redirects deleted: ${(r.value as { deleted: number }).deleted}`,
    };
  },
};
