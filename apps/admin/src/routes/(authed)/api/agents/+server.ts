// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #664 / #665 — every running agent the caller may manage, across
 * chats: the admin header's indicator polls this, so an agent started in
 * another tab, by another client or by an external MCP agent is always
 * visible — and stoppable — wherever the operator is in the admin.
 *
 *   GET                                               → { runs }
 *   POST { action: "cancel", chatSessionId, runId? }  → Stop
 *   POST { action: "allow", chatSessionId, runId }    → allow again
 */

import { error, json } from "@sveltejs/kit";
import {
  allowExternalAgent,
  assertJsonCsrf,
  cancelAgents,
  listAgentRuns,
  parseAgentAction,
} from "#lib/server/agent-runs.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  return json({ runs: await listAgentRuns(locals) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  await assertJsonCsrf(request, locals);
  const action = parseAgentAction(await request.json().catch(() => null));
  if (!action.chatSessionId) throw error(400, "chatSessionId is required here");
  if (action.action === "allow") {
    const allowed = await allowExternalAgent(locals, action.chatSessionId, action.runId);
    return json({ ok: true, allowed });
  }
  const result = await cancelAgents(locals, action.chatSessionId, action.runId);
  return json({ ok: true, ...result });
};
