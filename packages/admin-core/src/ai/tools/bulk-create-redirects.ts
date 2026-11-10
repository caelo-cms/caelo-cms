// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — `bulk_create_redirects`. The user pastes
 * a list of old → new path mappings (e.g. after a migration) → AI
 * does it in one tool call. Single tx, all-or-nothing.
 *
 * #1550 — saves pending changes: Staged by default (staging now, live with
 * the next Publish live), a Draft with `goLive: "later"`, and with `now` a
 * Go live now proposal the operator approves on its card.
 */

import { execute } from "@caelo-cms/query-api";
import { bulkCreateRedirectsToolInput } from "@caelo-cms/shared";
import { describeError, toolError } from "./_describe-error.js";
import { proposeRedirectGoLive } from "./_redirect-go-live.js";
import { redirectOnPageNote } from "./_redirect-on-page-note.js";
import { redirectSyncNote, type SavedRedirectChange } from "./_redirect-sync-note.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

/** The `goLive` property, shared by the redirect write tools. */
export const GO_LIVE_PROPERTY = {
  type: "string",
  enum: ["next_publish", "later", "now"],
  default: "next_publish",
  description:
    "next_publish: Staged (staging now, live with the next Publish live). later: Draft, served nowhere. now: ONLY when the operator asks for it live without Publish live; queues an approval card (needs the Publish live permission).",
} as const;

export const bulkCreateRedirectsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BulkCreateRedirectsToolInput
> = {
  name: "bulk_create_redirects",
  description:
    "Create or change redirects in one tx: a single one, a list ('/old-blog/* -> /blog/*' across many paths), a pasted CSV/table. `upsert:true` replaces an address's rule instead of skipping it.\n" +
    "Saved as pending changes, never live on save; the result says per rule where it is served.",
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
                "Path on this site, single leading '/' (e.g. '/blog/new'); never a full URL or '//host'. Another domain: `propose_external_redirect`.",
            },
            statusCode: { type: "integer", enum: [301, 302, 307, 308, 410], default: 301 },
          },
        },
      },
      upsert: { type: "boolean", default: false },
      goLive: GO_LIVE_PROPERTY,
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.create_many", {
      redirects: input.items,
      upsert: input.upsert,
      goLive: input.goLive === "later" ? "later" : "next_publish",
    });
    if (!r.ok) {
      return toolError(r.error, `redirects.create_many failed: ${describeError(r.error)}`);
    }
    const v = r.value as {
      created: number;
      updated: number;
      skipped: number;
      changes: SavedRedirectChange[];
    };
    const onPages = await redirectOnPageNote(ctx, toolCtx, {
      paths: input.items.map((i) => i.fromPath),
    });
    const body = `redirects: created=${v.created}, updated=${v.updated}, skipped=${v.skipped}${await redirectSyncNote(ctx, toolCtx, v.changes)}${onPages}`;
    if (input.goLive !== "now") return { ok: true, content: body };
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
