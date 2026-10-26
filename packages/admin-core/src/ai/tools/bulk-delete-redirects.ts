// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — `bulk_delete_redirects`. Three input
 * shapes: explicit ids, explicit fromPaths, or a substring `matches`
 * pattern. Exactly one of the three. Single tx.
 */

import { execute } from "@caelo-cms/query-api";
import { bulkDeleteRedirectsToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import { redirectSyncNote } from "./_redirect-sync-note.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const bulkDeleteRedirectsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BulkDeleteRedirectsToolInput
> = {
  name: "bulk_delete_redirects",
  description:
    "Delete redirects in one transaction by EXACTLY ONE of `redirectIds` | `fromPaths` | `matches` (substring of fromPath). " +
    "Run `find_redirects` first and tell the operator the count.\n" +
    "`matches` is capped at 10 rows for you (a substring match's blast radius is hard to predict; every deleted 301 strands inbound links): over the cap the call is REJECTED, nothing deleted -> list with `find_redirects`, show the operator, delete the confirmed ones by `redirectIds` (uncapped).\n" +
    "Gone from the live site when the call returns (pushed to hosting, no build); the result says so per target.",
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
      content: `redirects deleted: ${(r.value as { deleted: number }).deleted}\n${await redirectSyncNote(ctx, toolCtx)}`,
    };
  },
};
