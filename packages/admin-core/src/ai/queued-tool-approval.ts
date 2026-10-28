// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #687 — approval-gated tool calls that cannot pause an SDK turn.
 *
 * Inside a Live Edit turn, an approval-declared plugin tool (`set_locales`,
 * `reattach_chrome_variant`, …) is gated by the AI SDK's tool-approval
 * pause (CLAUDE.md §11.A, Plan B): the turn stops on an in-chat card and
 * resumes with the decision. The Power-MCP (#376) has no such turn — the
 * external agent drives its own loop — so these tools used to be refused
 * there outright, and the agent told the operator to paste a prompt into
 * the admin chat instead.
 *
 * This module gives them the same out-of-turn path core `needsApproval`
 * tools already use: the call is queued in `tool_approval_actions`
 * (domain `tool_approvals`), the operator approves the card in the Live
 * Edit chat strip or the pending queue, and the approved call runs with
 * the persisted arguments. #658's hand-off (`mcp_approval_handoffs`) then
 * carries the decision back to the agent and keeps the Live Edit AI out
 * of it.
 *
 * The apply path mirrors `attachPluginGatedExecute` (the in-chat gate) so
 * an approval means the same thing on both surfaces: it runs as the
 * approving operator with the plugin's own grants, the plugin host checks
 * the tool's `requiredPermission` against that operator, and it applies
 * live only when the approver may publish — otherwise it stays on the
 * proposing session's branch. External plugins record their installation
 * binding at queue time (keyed by the proposal id) and redeem it once on
 * approve, exactly like the in-chat card.
 */

import {
  hostInfra,
  hostSystemActorId,
  loadedPlugins,
  operatorHasPermission,
  pluginToolsRegistry,
  type RegisteredPluginTool,
  recordExternalToolApproval,
  runPluginOperation,
  toolArgsProblem,
} from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { untrustedToolResult } from "@caelo-cms/shared";
import {
  approvedCallRunsLive,
  approvedPluginInvocation,
  chatPluginInvocation,
} from "./plugin-invocation.js";
import { describeError } from "./tools/_describe-error.js";
import type { ToolResult } from "./tools/dispatch.js";
import { createDefaultToolRegistry } from "./tools/index.js";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Queue an approval-declared plugin tool call for the operator's click.
 *
 * Arguments are checked against the tool's schema first, so the operator
 * is never asked to approve a call that could not apply. Returns the
 * canonical "Queued proposal <uuid>:" result with `queuedProposalId`.
 *
 * @param input.aiCtx the calling agent's context — carries the session's
 *   branch and task; the queued row is attributed to this AI actor.
 * @param input.operatorActorId the human the agent works for (an external
 *   plugin's binding is redeemable only by them, as in the chat).
 */
export async function queuePluginToolApproval(input: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly aiCtx: ExecutionContext;
  readonly operatorActorId: string;
  readonly chatSessionId: string;
  readonly pluginTool: RegisteredPluginTool;
  readonly args: Record<string, unknown>;
  /** #741 — the agent does the AI work; the approved call must not spend the install's AI. */
  readonly aiDelegated?: boolean;
}): Promise<ToolResult> {
  const { spec, pluginSlug } = input.pluginTool;
  const problem = toolArgsProblem(spec, input.args);
  if (problem) {
    return {
      ok: false,
      content: `${problem}\nNothing was queued and no approval was requested — fix the arguments and call ${spec.name} again.`,
    };
  }
  // The id is chosen here so an external plugin's installation binding can
  // be recorded under it BEFORE the card becomes visible — an Approve in
  // between would otherwise find no binding and consume the proposal.
  const proposalId = crypto.randomUUID();
  const plugin = loadedPlugins.bySlug(pluginSlug);
  if (plugin?.externalApproval) {
    try {
      await recordExternalToolApproval({
        plugin,
        infra: hostInfra(),
        invocation: chatPluginInvocation(input.aiCtx, input.operatorActorId, {
          aiDelegated: input.aiDelegated === true,
        }),
        toolCallId: proposalId,
        args: input.args,
        toolName: spec.name,
        operationName: spec.operationName,
      });
    } catch (e) {
      return {
        ok: false,
        content: `${spec.name} could not be queued for approval: ${errorText(e)}. Nothing was queued or applied.`,
      };
    }
  }
  const queued = await execute(input.registry, input.adapter, input.aiCtx, "tool_approvals.queue", {
    proposalId,
    toolName: spec.name,
    args: input.args,
    preview: {
      // The card's one-line summary (pending_proposals.list shows it).
      summary: `${spec.name} ${JSON.stringify(input.args)}`.slice(0, 240),
      tool: spec.name,
      plugin: pluginSlug,
      args: input.args,
      ...(spec.requiredPermission ? { approverNeeds: spec.requiredPermission } : {}),
      // Read back by tool_approvals.read_for_execute when the card is approved.
      ...(input.aiDelegated ? { aiDelegated: true } : {}),
    },
    chatSessionId: input.chatSessionId,
  });
  if (!queued.ok) {
    // An already-recorded binding without its card simply expires (7 days).
    return {
      ok: false,
      content: `${spec.name} needs the operator's approval, but the approval card could not be queued (${describeError(queued.error)}). Nothing was applied; retry the call.`,
    };
  }

  return {
    ok: true,
    content:
      `Queued proposal ${proposalId}: ${spec.name} (plugin ${pluginSlug}) — waiting for the operator's Approve in the Caelo admin. ` +
      "Not applied yet; do not claim it is.",
    queuedProposalId: proposalId,
  };
}

/** What an approved queued call returned, as the queue and the hand-off record it. */
export interface ApprovedToolCallResult {
  readonly toolName: string;
  readonly chatSessionId: string | null;
  readonly ok: boolean;
  readonly content: string;
}

/**
 * Apply a pending `tool_approval_actions` row on the operator's Approve:
 * claims it atomically (a double click applies once), runs the tool with
 * the persisted arguments, and records the result on the row (which is
 * what `mcp.get_approval_outcome` hands back). Plugin tools run through
 * the plugin host like the in-chat gate does; built-in tools dispatch
 * through the chat-runner's registry as the approving human.
 *
 * Returns an error string when the row could not be claimed (unknown, or
 * already decided) or the approver cannot redeem a plugin call — that row
 * stays pending for someone who can. The caller checks the approver's
 * permission for built-in tools first (#589).
 */
export async function approveQueuedToolCall(input: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly approverCtx: ExecutionContext;
  readonly proposalId: string;
}): Promise<{ ok: true; value: ApprovedToolCallResult } | { ok: false; error: string }> {
  const { registry, adapter, approverCtx, proposalId } = input;
  // A plugin call the approver cannot redeem must be refused BEFORE the
  // claim, or the click would consume the proposal for nothing and lock
  // out the person who can approve it.
  const refusal = await pluginApproverRefusal(registry, adapter, approverCtx, proposalId);
  if (refusal) return { ok: false, error: refusal };
  const claim = await execute(registry, adapter, approverCtx, "tool_approvals.read_for_execute", {
    proposalId,
  });
  if (!claim.ok) return { ok: false, error: describeError(claim.error) };
  const { toolName, args, chatSessionId, chatBranchId, aiDelegated } = claim.value as {
    toolName: string;
    args: Record<string, unknown>;
    chatSessionId: string | null;
    chatBranchId: string | null;
    aiDelegated: boolean;
  };

  let result: { ok: boolean; content: string };
  try {
    const pluginTool = pluginToolsRegistry.resolve(toolName);
    result = pluginTool
      ? await runApprovedPluginTool(pluginTool, args, {
          approverId: approverCtx.actorId,
          proposalId,
          chatSessionId,
          chatBranchId,
          aiDelegated,
        })
      : await createDefaultToolRegistry().dispatch(toolName, args, approverCtx, {
          adapter,
          registry,
          ...(chatSessionId ? { chatSessionId } : {}),
        });
  } catch (e) {
    result = { ok: false, content: `dispatch threw: ${errorText(e)}` };
  }

  const marked = await execute(registry, adapter, approverCtx, "tool_approvals.mark_result", {
    proposalId,
    ok: result.ok,
    summary: result.content.slice(0, 2000),
  });
  if (!marked.ok) {
    // The call already ran; a missing result only leaves the hand-off
    // reporting it as in flight. Say so loudly (CLAUDE.md §2).
    console.error("[tool_approvals] mark_result failed after an approved call", {
      proposalId,
      toolName,
      error: marked.error,
    });
  }
  return { ok: true, value: { toolName, chatSessionId, ok: result.ok, content: result.content } };
}

/**
 * Why `approverCtx` cannot approve this queued plugin call, or null. Built-in
 * tools and rows that are no longer pending return null (the route checks
 * built-ins; the claim reports a decided row).
 */
async function pluginApproverRefusal(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  approverCtx: ExecutionContext,
  proposalId: string,
): Promise<string | null> {
  const pending = await execute(registry, adapter, approverCtx, "tool_approvals.list_pending", {
    proposalId,
  });
  if (!pending.ok) return `could not read the approval queue (${describeError(pending.error)})`;
  const row = (
    pending.value as { proposals: Array<{ id: string; toolName: string; proposedBy: string }> }
  ).proposals.find((p) => p.id === proposalId);
  const pluginTool = row ? pluginToolsRegistry.resolve(row.toolName) : null;
  if (!row || !pluginTool) return null;
  const plugin = loadedPlugins.bySlug(pluginTool.pluginSlug);
  // The installation binding names the operator the agent works for (the
  // queuing actor), and only they can redeem it — as with the in-chat card.
  if (plugin?.externalApproval && row.proposedBy !== approverCtx.actorId) {
    return (
      `Only the person the requesting agent works for can approve this ${pluginTool.spec.name} call ` +
      "(the plugin's approval is bound to them). It stays pending for them."
    );
  }
  const permission = pluginTool.spec.requiredPermission;
  if (
    permission &&
    !(await operatorHasPermission(
      hostInfra(),
      hostSystemActorId(),
      approverCtx.actorId,
      permission,
    ))
  ) {
    return `Approving ${pluginTool.spec.name} needs the ${permission} permission. It stays pending for someone who holds it.`;
  }
  return null;
}

async function runApprovedPluginTool(
  pluginTool: RegisteredPluginTool,
  args: Record<string, unknown>,
  call: {
    approverId: string;
    proposalId: string;
    chatSessionId: string | null;
    chatBranchId: string | null;
    aiDelegated: boolean;
  },
): Promise<{ ok: boolean; content: string }> {
  // Same rule as the in-chat gate: live only for an approver who could
  // publish it anyway, and not for a draft-bound tool; otherwise it stays
  // on the proposing session's branch.
  const canPublish = await operatorHasPermission(
    hostInfra(),
    hostSystemActorId(),
    call.approverId,
    "deploy.trigger",
  );
  const delegation = { aiDelegated: call.aiDelegated };
  const invocation =
    approvedCallRunsLive(canPublish, pluginTool.spec) || !call.chatBranchId
      ? approvedPluginInvocation(call.approverId, undefined, delegation)
      : approvedPluginInvocation(
          call.approverId,
          {
            chatBranchId: call.chatBranchId,
            ...(call.chatSessionId ? { chatTaskId: call.chatSessionId } : {}),
          },
          delegation,
        );
  const r = await runPluginOperation({
    approvedToolName: pluginTool.spec.name,
    // An external plugin's binding was recorded under the proposal id.
    approvedToolCallId: call.proposalId,
    ...(call.chatBranchId ? { approvedChatBranchId: call.chatBranchId } : {}),
    pluginSlug: pluginTool.pluginSlug,
    operationName: pluginTool.spec.operationName,
    args,
    invocation,
  });
  // #635 — plugin data may be visitor-written: data, never instructions.
  return r.ok
    ? { ok: true, content: untrustedToolResult(r.value) }
    : { ok: false, content: `${r.error.kind}: ${r.error.message}` };
}
