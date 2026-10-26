// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — `bulk_create_redirects`. The user pastes
 * a list of old → new path mappings (e.g. after a migration) → AI
 * does it in one tool call. Single tx, all-or-nothing.
 */

import { execute } from "@caelo-cms/query-api";
import { bulkCreateRedirectsToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import { redirectSyncNote } from "./_redirect-sync-note.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const bulkCreateRedirectsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BulkCreateRedirectsToolInput
> = {
  name: "bulk_create_redirects",
  description:
    "Create redirects in one transaction — one call for 1..N (`items[]`): a single redirect (one-item array), a list ('/old-blog/* -> /blog/*' across many paths), a pasted CSV/table. `upsert:true` updates existing fromPath rows instead of skipping them.\n" +
    "Live on the site when the call returns: pushed to hosting without a build or Publish live. The result says so per target and names redirects whose target page is not published yet (404 there until Publish live).",
  schema: bulkCreateRedirectsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fromPath", "toPath"],
          properties: {
            fromPath: { type: "string", minLength: 1, maxLength: 500 },
            toPath: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description:
                "Path on this site starting with a single '/' (e.g. '/blog/new'); never a full URL or '//host' — external targets unsupported.",
            },
            statusCode: { type: "integer", enum: [301, 302, 307, 308, 410], default: 301 },
          },
        },
      },
      upsert: { type: "boolean", default: false },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.create_many", {
      redirects: input.items,
      upsert: input.upsert,
    });
    if (!r.ok) {
      return { ok: false, content: `redirects.create_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as { created: number; updated: number; skipped: number };
    return {
      ok: true,
      content: `redirects: created=${v.created}, updated=${v.updated}, skipped=${v.skipped}\n${await redirectSyncNote(ctx, toolCtx)}`,
    };
  },
};
