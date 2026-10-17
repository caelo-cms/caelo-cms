// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #664 / #665 — server side of the running-agents bar (Live Edit)
 * and the header indicator: list what runs, Stop it, allow a stopped
 * external agent again. Shared by the per-chat and the site-wide endpoint.
 *
 * Authorization: an operator sees and stops the agents of their OWN chats
 * (the chat ops filter sessions by creator); an operator holding
 * `settings.write` (site administration) sees and stops every chat's —
 * the Owner must always be able to stop an agent, whoever started it.
 * Every Stop / Allow is audited by its op.
 */

import { abortLocalAgentRuns, verifyCsrfToken } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";

/** One row of the running-agents list (chat.list_agent_runs). */
export interface AgentRunView {
  id: string;
  chatSessionId: string;
  chatTitle: string;
  kind: "turn" | "subagent" | "mcp";
  source: "live_edit" | "mcp_chat" | "power_mcp" | "subagent";
  label: string;
  state: "queued" | "running" | "stopped";
  parentRunId: string | null;
  createdAt: string;
  heartbeatAt: string;
  cancelRequested: boolean;
}

function canManageAllChats(user: NonNullable<App.Locals["user"]>): boolean {
  return user.permissions.has("settings.write");
}

/** CSRF for JSON POSTs: the token rides in `x-csrf-token` (as on the chat stream). */
export async function assertJsonCsrf(request: Request, locals: App.Locals): Promise<void> {
  if (!locals.user) throw error(401, "Not authenticated");
  const ok = await verifyCsrfToken(
    locals.user.csrfSecret,
    request.headers.get("x-csrf-token") ?? "",
  );
  if (!ok) throw error(403, "CSRF token mismatch");
}

/** 404 unless the caller may see / stop the agents of `chatSessionId`. */
export async function assertChatAccess(locals: App.Locals, chatSessionId: string): Promise<void> {
  const user = requirePermission(locals, "content.read");
  if (canManageAllChats(user)) return;
  const { adapter, registry } = getQueryContext();
  // chat.get_session reads only the caller's own sessions.
  const own = await execute(registry, adapter, locals.ctx, "chat.get_session", { chatSessionId });
  if (!own.ok) throw error(404, "Chat not found");
}

/** Running agents of one chat, or of every chat the caller may manage. */
export async function listAgentRuns(
  locals: App.Locals,
  chatSessionId?: string,
): Promise<AgentRunView[]> {
  const user = requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "chat.list_agent_runs", {
    ...(chatSessionId ? { chatSessionId } : {}),
    ...(canManageAllChats(user) ? {} : { createdBy: user.id }),
  });
  if (!r.ok) throw error(500, "Could not read the running agents");
  return (r.value as { runs: AgentRunView[] }).runs;
}

/** Stop one agent (`runId`) or everything running in the chat. */
export async function cancelAgents(
  locals: App.Locals,
  chatSessionId: string,
  runId: string | undefined,
): Promise<{ cancelledRunIds: string[]; stoppedExternalAgents: number; chatStopped: boolean }> {
  requirePermission(locals, "content.write");
  await assertChatAccess(locals, chatSessionId);
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "chat.cancel_agents", {
    chatSessionId,
    ...(runId ? { runId } : {}),
  });
  if (!r.ok) {
    const msg = "message" in r.error ? String(r.error.message) : r.error.kind;
    throw error(r.error.kind === "HandlerError" ? 409 : 500, msg);
  }
  const value = r.value as {
    cancelledRunIds: string[];
    stoppedExternalAgents: number;
    chatStopped: boolean;
  };
  // Runs on this instance stop now; the others on their next heartbeat (≤1 s).
  abortLocalAgentRuns(value.cancelledRunIds);
  return value;
}

/** Lift a stopped external agent's block in the chat. */
export async function allowExternalAgent(
  locals: App.Locals,
  chatSessionId: string,
  runId: string,
): Promise<boolean> {
  requirePermission(locals, "content.write");
  await assertChatAccess(locals, chatSessionId);
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "chat.allow_external_agent", {
    chatSessionId,
    runId,
  });
  if (!r.ok) throw error(500, "Could not allow the external agent again");
  return (r.value as { allowed: boolean }).allowed;
}

/** The POST body both endpoints accept (Zod at the boundary). */
const agentActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("cancel"),
      chatSessionId: z.string().uuid().optional(),
      /** One running-agents entry; omitted = everything in the chat. */
      runId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("allow"),
      chatSessionId: z.string().uuid().optional(),
      runId: z.string().uuid(),
    })
    .strict(),
]);

/** Parse the POST body both endpoints accept; 400 with the issues otherwise. */
export function parseAgentAction(body: unknown): z.infer<typeof agentActionSchema> {
  const parsed = agentActionSchema.safeParse(body);
  if (!parsed.success) {
    throw error(400, `invalid agent action: ${parsed.error.message}`);
  }
  return parsed.data;
}
