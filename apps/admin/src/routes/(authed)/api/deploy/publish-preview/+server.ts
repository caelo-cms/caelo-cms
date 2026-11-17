// SPDX-License-Identifier: MPL-2.0

/**
 * What the next Publish live changes, for its review in the editor
 * toolbar (`PublishLiveReview.svelte`):
 *
 *   GET → { preview: deploy.publish_preview, redirects: redirects.release_plan }
 *
 * Both are read for the same click: the review posts the staged run it
 * showed (`stagedRunId`, deploy.promote refuses another build) and the
 * `goingLive` redirect changes (id + revision), so exactly what it listed
 * goes live.
 */

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  requirePermission(locals, "deploy.trigger");
  const { adapter, registry } = getQueryContext();
  const [preview, redirects] = await Promise.all([
    execute(registry, adapter, locals.ctx, "deploy.publish_preview", {}),
    execute(registry, adapter, locals.ctx, "redirects.release_plan", {}),
  ]);
  if (!preview.ok) {
    console.error("[publish-preview] deploy.publish_preview failed", { error: preview.error });
    throw error(500, `What Publish live changes could not be read: ${describeError(preview.error)}`);
  }
  if (!redirects.ok) {
    console.error("[publish-preview] redirects.release_plan failed", { error: redirects.error });
    throw error(500, `The redirects of this Publish live could not be read: ${describeError(redirects.error)}`);
  }
  return json({ preview: preview.value, redirects: redirects.value });
};
