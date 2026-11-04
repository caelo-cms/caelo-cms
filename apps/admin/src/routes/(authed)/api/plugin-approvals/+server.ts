// SPDX-License-Identifier: MPL-2.0

/**
 * #1420 — what waits for an Owner's decision on a plugin, and the approval.
 *
 *   GET  → { releases, reviews, canApprove }
 *   POST { slug, manifestDigest } → { loaded, message }
 *
 * Everyone signed in sees that a plugin is stopped: Publish live refuses for
 * them too, and they have to know why. Approving, and installed packages
 * still under review, are for whoever may decide.
 */

import { loadActivatedPlugin } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { assertJsonCsrf } from "#lib/server/agent-runs.js";
import { holdsApproverPermission, requireApproverPermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const APPROVE_OP = "plugins.approve_capabilities";

const approveInput = z
  .object({
    slug: z.string().min(1).max(120),
    manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const GET: RequestHandler = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "plugins.list_approvals", {});
  if (!r.ok) throw error(500, "message" in r.error ? String(r.error.message) : r.error.kind);
  const value = r.value as { releases: unknown[]; reviews: unknown[] };
  const canApprove = holdsApproverPermission(locals, registry, APPROVE_OP);
  return json({ releases: value.releases, reviews: canApprove ? value.reviews : [], canApprove });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const { adapter, registry } = getQueryContext();
  requireApproverPermission(locals, registry, APPROVE_OP);
  await assertJsonCsrf(request, locals);
  const parsed = approveInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw error(400, "Expected { slug, manifestDigest }");
  const r = await execute(registry, adapter, locals.ctx, APPROVE_OP, parsed.data);
  if (!r.ok) throw error(409, "message" in r.error ? String(r.error.message) : r.error.kind);
  const { slug } = parsed.data;
  const live = await loadActivatedPlugin(slug);
  return json({
    loaded: live.loaded,
    message: live.loaded
      ? `${slug} runs again.`
      : `Approved, but ${slug} could not be loaded on this server (${live.reason}). Settings → Plugins shows the error.`,
  });
};
