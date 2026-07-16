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
    "**`matches` is capped at 10 rows for you** (CLAUDE.md §11.A — a substring match's blast radius is hard to " +
    "predict, and every deleted 301 strands an inbound link). If it would hit more, the call is REJECTED and " +
    "nothing is deleted: list them with `find_redirects`, show the operator the list, and delete the confirmed " +
    "ones by explicit `redirectIds`. That path is uncapped because you enumerated exactly what goes. " +
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
