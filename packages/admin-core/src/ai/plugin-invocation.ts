// SPDX-License-Identifier: MPL-2.0

import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import type { ExecutionContext } from "@caelo-cms/shared";

/**
 * The plugin invocation for a call made inside a chat turn: the AI acts,
 * for the chat's human, on the chat's branch (CMS_REQUIREMENTS §14.7).
 * Built in one place so the chat, the approval-gated path and Power-MCP
 * hand plugins the identical context.
 *
 * @param aiCtx the AI actor's context carrying the chat branch + task
 * @param operatorActorId the human the chat belongs to
 * @param opts.aiDelegated the calling agent does the AI work (Power-MCP, #741)
 */
export function chatPluginInvocation(
  aiCtx: ExecutionContext,
  operatorActorId: string,
  opts: { readonly aiDelegated?: boolean } = {},
): PluginInvocation {
  return {
    origin: "chat",
    actorId: aiCtx.actorId,
    operatorActorId,
    ...(aiCtx.chatBranchId ? { chatBranchId: aiCtx.chatBranchId } : {}),
    ...(aiCtx.chatTaskId ? { chatTaskId: aiCtx.chatTaskId } : {}),
    ...(opts.aiDelegated ? { aiDelegated: true } : {}),
  };
}

/**
 * The plugin invocation for an approval-gated plugin tool after the
 * click (CMS_REQUIREMENTS §14.7). An approved action applies live when
 * the approver may publish (`deploy.trigger`) — the click is then the
 * publishing decision. An approver who cannot publish keeps it on the
 * chat's branch, so it goes live with the chat, by someone who may.
 *
 * @param operatorActorId the human who approved
 * @param chatBranch the chat's branch and task, when the action must stay on it
 * @param opts.aiDelegated the call was requested by an external agent that
 *   does the AI work itself (#741): approving it never spends the install's AI
 */
export function approvedPluginInvocation(
  operatorActorId: string,
  chatBranch?: { readonly chatBranchId: string; readonly chatTaskId?: string },
  opts: { readonly aiDelegated?: boolean } = {},
): PluginInvocation {
  return {
    origin: "approved",
    actorId: operatorActorId,
    ...(chatBranch ?? {}),
    ...(opts.aiDelegated ? { aiDelegated: true } : {}),
  };
}
