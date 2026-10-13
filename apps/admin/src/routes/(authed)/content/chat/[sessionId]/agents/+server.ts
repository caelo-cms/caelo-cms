// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #664 / #665 — the running agents of ONE chat (the Live Edit
 * running-agents bar) and the authoritative Stop.
 *
 *   GET                                  → { runs: AgentRunView[] }
 *   POST { action: "cancel", runId? }    → stop one entry, or (no runId)
 *                                          everything running in the chat
 *   POST { action: "allow", runId }      → let a stopped external agent
 *                                          work in this chat again
 *
 * Stop no longer depends on the browser's fetch abort reaching the server
 * (behind Cloud Run it did not): the cancel op flags the runs in the
 * database, runs on this instance abort at once, every other instance's
 * runner sees the flag on its next heartbeat.
 */

import { json } from "@sveltejs/kit";
import {
  allowExternalAgent,
  assertChatAccess,
  assertJsonCsrf,
  cancelAgents,
  listAgentRuns,
  parseAgentAction,
} from "#lib/server/agent-runs.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  await assertChatAccess(locals, params.sessionId);
  return json({ runs: await listAgentRuns(locals, params.sessionId) });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  await assertJsonCsrf(request, locals);
  const action = parseAgentAction(await request.json().catch(() => null));
  if (action.action === "allow") {
    const allowed = await allowExternalAgent(locals, params.sessionId, action.runId);
    return json({ ok: true, allowed });
  }
  const result = await cancelAgents(locals, params.sessionId, action.runId);
  return json({ ok: true, ...result });
};
