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
 */
export function chatPluginInvocation(
  aiCtx: ExecutionContext,
  operatorActorId: string,
): PluginInvocation {
  return {
    origin: "chat",
    actorId: aiCtx.actorId,
    operatorActorId,
    ...(aiCtx.chatBranchId ? { chatBranchId: aiCtx.chatBranchId } : {}),
    ...(aiCtx.chatTaskId ? { chatTaskId: aiCtx.chatTaskId } : {}),
  };
}

/**
 * The plugin invocation for an approval-gated plugin tool after the
 * Owner's click: an approved action applies live (CMS_REQUIREMENTS
 * §14.7), so it runs on main as the approving Owner — not on the chat's
 * branch, where it would wait for a second, publishing decision.
 *
 * @param operatorActorId the Owner who approved
 */
export function approvedPluginInvocation(operatorActorId: string): PluginInvocation {
  return { origin: "approved", actorId: operatorActorId };
}
