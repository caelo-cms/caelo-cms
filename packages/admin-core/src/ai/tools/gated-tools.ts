// SPDX-License-Identifier: MPL-2.0

/**
 * Gated tools — SDK-executed, human-approval-gated (CLAUDE.md §11.A, Plan B).
 *
 * A gated tool (any tool whose registry definition carries `gated`, set by
 * `makeProposeTool`) is the SDK-native replacement for the old
 * `propose_*` + `/security/pending` Approve dance: the AI calls the action
 * directly, but the SDK PAUSES on a `tool-approval-request` before running the
 * tool's `execute`. The Owner approves in-chat; the SDK then runs `execute`,
 * which chains the existing per-domain machinery:
 *
 *   1. `<domain>.propose_<action>` (AI ctx) — writes the pending row, computes
 *      the preview jsonb, records audit;
 *   2. `<domain>.execute_proposal({proposalId})` (Owner live ctx) — applies the
 *      real mutation, exactly as the /security/pending Approve did.
 *
 * Reusing propose/execute keeps every domain's apply logic correct (including
 * multi-op fan-outs like a layout's html+blocks) with ZERO reimplementation —
 * the SDK gate simply sits in front of it. The pending tables survive as the
 * internal apply + audit engine; only the AI-facing propose_* choreography and
 * the separate Owner queue are gone.
 */

import {
  hostInfra,
  hostSystemActorId,
  loadActivatedPlugin,
  loadedPlugins,
  operatorHasPermission,
  recordExternalToolApproval,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  approverPermissionsOf,
  isApproverPermissionRefusal,
} from "../../ops/_approver-permission.js";
import { describePersistError } from "../chat-runner/persistence.js";
import type { FilteredTool } from "../chat-runner/tool-catalogue.js";
import { approvedPluginInvocation } from "../plugin-invocation.js";

/**
 * Attach the SDK `execute` to a gated catalogue tool. The returned tool ships
 * to the provider with `approvalMode` + `execute`; the SDK pauses before
 * `execute` until a human approves, then runs propose (AI) + execute_proposal
 * (as the approving human, live). `ownerCtxLive` is the context of whoever
 * clicked Approve and MUST be branch-free (a live-commit) so an approved
 * change applies site-wide immediately, matching the old flow.
 *
 * #589 — the click alone does not authorise: anyone who can chat sees the
 * card. The executor op declares the permission its approver must hold
 * (`requiresApproverPermission`) and refuses anyone without it; this execute
 * fails closed when an executor declares none, and turns a refusal into a
 * clear "still pending at <queue>" result instead of a generic failure.
 */
export function attachGatedExecute(
  tool: FilteredTool,
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  aiCtx: ExecutionContext,
  ownerCtxLive: ExecutionContext,
): FilteredTool {
  const gated = tool.gated;
  if (!gated) return tool;
  return {
    ...tool,
    approvalMode: "user-approval",
    execute: async (input: unknown): Promise<unknown> => {
      // 0. Fail closed: an executor that names no approver permission would
      //    let any chat user's click apply the change. The CI guard keeps
      //    this unreachable; the runtime check keeps it safe if it is not.
      const executor = registry.lookup(gated.executeOp);
      const required = executor.ok ? approverPermissionsOf(executor.value) : null;
      if (!required) {
        console.error("[gated-tool] executor declares no approver permission — refusing", {
          tool: tool.name,
          executeOp: gated.executeOp,
        });
        return {
          ok: false,
          error: `${tool.name} cannot be approved: ${gated.executeOp} declares no approver permission. Nothing was proposed or applied — report this as a bug.`,
        };
      }
      // 1. Propose as the AI — validates, writes the pending row + preview.
      const proposed = await execute(
        registry,
        adapter,
        aiCtx,
        gated.proposeOp,
        input as Record<string, unknown>,
      );
      if (!proposed.ok) {
        return {
          ok: false,
          error: `${gated.proposeOp} failed: ${describePersistError(proposed.error)}`,
        };
      }
      const proposalId = (proposed.value as { proposalId?: string }).proposalId;
      if (!proposalId) {
        return { ok: false, error: `${gated.proposeOp} returned no proposalId` };
      }
      // 2. Apply as the approving human (live-commit) — the approved
      //    mutation. The executor checks the approver's permission first.
      const applied = await execute(registry, adapter, ownerCtxLive, gated.executeOp, {
        proposalId,
      });
      if (!applied.ok) {
        if (
          applied.error.kind === "HandlerError" &&
          isApproverPermissionRefusal(applied.error.message)
        ) {
          // The proposal row is untouched and stays pending, so someone
          // who holds the permission can approve it from the queue.
          return {
            ok: false,
            error:
              `Not applied: the person who clicked Approve lacks ${required.join(" + ")}. ` +
              `Proposal ${proposalId} stays pending at ${gated.pendingQueuePath} — tell the operator ` +
              `an Owner (or anyone holding ${required.join(" + ")}) must approve it there. Do not propose it again.`,
          };
        }
        return {
          ok: false,
          error: `${gated.executeOp} failed: ${describePersistError(applied.error)}`,
        };
      }
      // 3. Post-commit step, if the domain declared one. The apply
      //    transaction is closed by now, which is the whole reason this
      //    is not folded into `execute_proposal`.
      if (gated.afterApply === "load-activated-plugin") {
        const slug = (applied.value as { slug?: string }).slug;
        if (slug) {
          const live = await loadActivatedPlugin(slug);
          if (!live.loaded) {
            // The row IS active; only the in-process load failed. Say so
            // precisely rather than reporting a clean success the
            // operator would find untrue, or a failure that would send
            // them re-approving something already applied.
            return {
              ok: true,
              value: {
                ...(applied.value as Record<string, unknown>),
                loadedIntoHost: false,
                warning: `"${slug}" is activated but could not be loaded into the running host (${live.reason}). It will load on the next restart; do not use its tools before then.`,
              },
            };
          }
          return {
            ok: true,
            value: {
              ...(applied.value as Record<string, unknown>),
              loadedIntoHost: true,
              note: "The plugin is running. Its tools and skills become available to you on your NEXT turn — this turn's tool list was fixed before the approval.",
            },
          };
        }
      }
      return { ok: true, value: applied.value };
    },
  };
}

/**
 * #388 — attach the SDK `execute` to an approval-declared PLUGIN tool.
 * Same pause semantics as `attachGatedExecute`, different apply path:
 * after the Owner's in-chat Approve, the SDK runs `execute`, which
 * dispatches the plugin operation through `runPluginOperation` (the
 * plugin's own actor + RLS scoping). Before this, a plugin tool had no
 * way to express an approval requirement at all — every call ran
 * unqueued and unapproved.
 */
export function attachPluginGatedExecute(
  tool: FilteredTool,
  /** The chat the tool is offered in; its operator is the one who approves. */
  chat: PluginInvocation,
): FilteredTool {
  const pluginGated = tool.pluginGated;
  if (!pluginGated) return tool;
  const plugin = loadedPlugins.bySlug(pluginGated.pluginSlug);
  return {
    ...tool,
    approvalMode: "user-approval",
    ...(plugin?.externalApproval
      ? {
          prepareApproval: async (toolCallId: string, args: unknown) =>
            recordExternalToolApproval({
              plugin,
              infra: hostInfra(),
              invocation: chat,
              toolCallId,
              args,
              toolName: tool.name,
              operationName: pluginGated.operationName,
            }),
        }
      : {}),
    execute: async (input: unknown, options?: { toolCallId?: string }): Promise<unknown> => {
      const approver = chat.operatorActorId;
      if (!approver)
        return { ok: false, error: "ApprovalWithoutOperator: no human approved this call" };
      // Live only for an approver who could publish it anyway; otherwise the
      // approved action stays on the chat's branch until someone publishes.
      const canPublish = await operatorHasPermission(
        hostInfra(),
        hostSystemActorId(),
        approver,
        "deploy.trigger",
      );
      const invocation =
        canPublish || !chat.chatBranchId
          ? approvedPluginInvocation(approver)
          : approvedPluginInvocation(approver, {
              chatBranchId: chat.chatBranchId,
              ...(chat.chatTaskId ? { chatTaskId: chat.chatTaskId } : {}),
            });
      const r = await runPluginOperation({
        approvedToolName: tool.name,
        approvedToolCallId: options?.toolCallId,
        ...(chat.chatBranchId ? { approvedChatBranchId: chat.chatBranchId } : {}),
        pluginSlug: pluginGated.pluginSlug,
        operationName: pluginGated.operationName,
        args: input,
        invocation,
      });
      if (!r.ok) {
        return { ok: false, error: `${r.error.kind}: ${r.error.message}` };
      }
      return { ok: true, value: r.value };
    },
  };
}
