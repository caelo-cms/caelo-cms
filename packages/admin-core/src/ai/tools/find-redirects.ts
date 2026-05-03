// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — `find_redirects`. List + filter the
 * redirects table without paginating through everything. Pre-flight
 * for `bulk_delete_redirects` ("delete redirects from /old-blog/*"
 * → AI calls find first to confirm the count, then bulk-deletes).
 */

import { execute } from "@caelo-cms/query-api";
import { findRedirectsToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const findRedirectsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").FindRedirectsToolInput
> = {
  name: "find_redirects",
  description:
    "Search redirects by substring of fromPath or toPath, optionally filtered by statusCode. " +
    "Returns up to `limit` matches plus a totalCount. " +
    "Use as a pre-flight check before `bulk_delete_redirects` so the user sees what will be removed. " +
    "Don't use to grab a single redirect by exact fromPath — use `redirects.lookup` (one-row lookup) instead.",
  schema: findRedirectsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 500 },
      statusCode: { type: "integer", enum: [301, 302, 307, 308, 410] },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.list", input);
    if (!r.ok) return { ok: false, content: `redirects.list failed: ${describeError(r.error)}` };
    const { redirects, totalCount } = r.value as {
      redirects: { fromPath: string; toPath: string; statusCode: number }[];
      totalCount: number;
    };
    if (redirects.length === 0) {
      return { ok: true, content: `No redirects matched. Total in table: ${totalCount}.` };
    }
    const lines = redirects.map((r) => `- ${r.fromPath} → ${r.toPath} (${r.statusCode})`);
    return {
      ok: true,
      content: `Matches (showing ${redirects.length} of ${totalCount}):\n${lines.join("\n")}`,
    };
  },
};
