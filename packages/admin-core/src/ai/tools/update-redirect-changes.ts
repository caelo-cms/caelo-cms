// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — `update_redirect_changes`: the state transitions of pending
 * redirect changes in one call — include (Draft → Staged), keep as draft
 * (Staged → Draft), discard, and go live now (an approval card; the
 * operator approves it, the approver needs the Publish live permission).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import { proposeRedirectGoLive } from "./_redirect-go-live.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z
  .object({
    fromPaths: z
      .array(z.string().min(1).max(500))
      .min(1)
      .max(500)
      .describe("From paths of pending changes, as find_redirects lists them."),
    action: z
      .enum(["include", "keep_as_draft", "discard", "go_live_now"])
      .describe(
        "include: Draft -> Staged (live with the next Publish live). keep_as_draft: Staged -> Draft (served nowhere). discard: drop the change, the live rule stays. go_live_now: ONLY when the operator asks; queues an approval card that puts manual changes live without Publish live.",
      ),
  })
  .strict();

export const updateRedirectChangesTool: ToolDefinitionWithHandler<z.infer<typeof input>> = {
  name: "update_redirect_changes",
  description:
    "Change the state of saved redirect changes that are not live yet (find_redirects {state:'staged'|'draft'} lists them). New rules or removals: bulk_create_redirects / bulk_delete_redirects.",
  schema: input,
  handler: async (ctx, args, toolCtx) => {
    if (args.action === "go_live_now") {
      const proposed = await proposeRedirectGoLive(ctx, toolCtx, args.fromPaths);
      if (!proposed.ok) {
        return { ok: false, content: `No Go live now was queued: ${proposed.why}` };
      }
      return { ok: true, content: proposed.card };
    }
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.set_changes_state", {
      fromPaths: args.fromPaths,
      action: args.action,
    });
    if (!r.ok) {
      return toolError(r.error, `redirects.set_changes_state failed: ${describeError(r.error)}`);
    }
    const { changed } = r.value as { changed: number };
    const what =
      args.action === "include"
        ? "Staged: staging serves them now, the live site with the next Publish live"
        : args.action === "keep_as_draft"
          ? "kept as Draft: served nowhere, Publish live leaves them out"
          : "discarded: the live rules stay as they are";
    return { ok: true, content: `${changed} of ${args.fromPaths.length} changes ${what}.` };
  },
};
