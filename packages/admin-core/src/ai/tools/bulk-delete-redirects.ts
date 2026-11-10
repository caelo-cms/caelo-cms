// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — `bulk_delete_redirects`. Three input
 * shapes: explicit ids, explicit fromPaths, or a substring `matches`
 * pattern. Exactly one of the three. Single tx.
 *
 * #1550 — a removal is a pending change like any other: Staged by default
 * (gone from staging now, from the live site with the next Publish live), a
 * Draft with `goLive: "later"`, and with `now` a Go live now proposal.
 */

import { execute } from "@caelo-cms/query-api";
import { bulkDeleteRedirectsToolInput } from "@caelo-cms/shared";
import { describeError, toolError } from "./_describe-error.js";
import { proposeRedirectGoLive } from "./_redirect-go-live.js";
import { redirectSyncNote, type SavedRedirectChange } from "./_redirect-sync-note.js";
import { GO_LIVE_PROPERTY } from "./bulk-create-redirects.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const bulkDeleteRedirectsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BulkDeleteRedirectsToolInput
> = {
  name: "bulk_delete_redirects",
  description:
    "Delete redirects in one transaction by EXACTLY ONE of `redirectIds`, `fromPaths`, `matches` (one redirect = one-item array). Run `find_redirects` FIRST and tell the user the count.\n" +
    "`matches` (substring) is capped at 10 rows for you (every deleted 301 strands an inbound link): more -> REJECTED, nothing deleted; list them with `find_redirects`, show the operator, delete the confirmed ones by `redirectIds` (uncapped).\n" +
    "Saved as pending removals (a rule not live yet is simply dropped); the result says per rule where it is gone.",
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
      goLive: GO_LIVE_PROPERTY,
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const { goLive, ...which } = input;
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.delete_many", {
      ...which,
      goLive: goLive === "later" ? "later" : "next_publish",
    });
    if (!r.ok) {
      return toolError(r.error, `redirects.delete_many failed: ${describeError(r.error)}`);
    }
    const v = r.value as { deleted: number; changes: SavedRedirectChange[] };
    const body = `redirects deleted: ${v.deleted}${await redirectSyncNote(ctx, toolCtx, v.changes)}`;
    if (goLive !== "now") return { ok: true, content: body };
    const pending = v.changes.filter((c) => c.outcome === "pending").map((c) => c.fromPath);
    if (pending.length === 0) return { ok: true, content: body };
    const proposed = await proposeRedirectGoLive(ctx, toolCtx, pending);
    return {
      ok: true,
      content: proposed.ok
        ? `${proposed.card}\n${body}`
        : `${body}\nNo Go live now was queued: ${proposed.why}`,
    };
  },
};
