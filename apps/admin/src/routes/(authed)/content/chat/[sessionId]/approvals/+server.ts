// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — the operator decides an external agent's in-chat approval
 * card (a caelo_chat turn paused on a gated tool in this session).
 *
 *   POST { approvalId, approved, reason? } → { approval }
 *
 * This only RECORDS the decision (`chat.decide_turn_approval`): the
 * external agent's own call resumes its turn and gets the result. No AI
 * turn of this chat starts — that is the point (CLAUDE.md §11.A: the result
 * belongs to whoever asked). This chat's own AI's cards resume through the
 * stream route's `resumeApproval` instead.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { assertChatAccess, assertJsonCsrf } from "#lib/server/agent-runs.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const decisionInput = z
  .object({
    approvalId: z.string().min(1).max(200),
    approved: z.boolean(),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export const POST: RequestHandler = async ({ params, request, locals }) => {
  requirePermission(locals, "content.write");
  await assertJsonCsrf(request, locals);
  await assertChatAccess(locals, params.sessionId);
  const parsed = decisionInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw error(400, "Expected { approvalId, approved, reason? }");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "chat.decide_turn_approval", {
    chatSessionId: params.sessionId,
    ...parsed.data,
  });
  if (!r.ok) {
    const msg = "message" in r.error ? String(r.error.message) : r.error.kind;
    throw error(r.error.kind === "HandlerError" ? 409 : 500, msg);
  }
  return json(r.value);
};
