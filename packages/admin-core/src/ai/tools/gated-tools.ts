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
import { describeOperatorAccessSync, type OperatorAccessSync } from "../../ops/user_access.js";
import { RESYNC_HINT } from "../../security/operator-access/gcp-iap.js";
import { describePersistError } from "../chat-runner/persistence.js";
import type { FilteredTool } from "../chat-runner/tool-catalogue.js";
import { approvedPluginInvocation } from "../plugin-invocation.js";

/**
 * Attach the SDK `execute` to a gated catalogue tool. The returned tool ships
 * to the provider with `approvalMode` + `execute`; the SDK pauses before
 * `execute` until the Owner approves, then runs propose (AI) + execute_proposal
 * (Owner live). `ownerCtxLive` MUST be branch-free (a live-commit) so an
 * approved change applies site-wide immediately, matching the old flow.
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
      // 2. Apply as the Owner (live-commit) — the approved mutation.
      const applied = await execute(registry, adapter, ownerCtxLive, gated.executeOp, {
        proposalId,
      });
      if (!applied.ok) {
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
      if (gated.afterApply === "sync-operator-access") {
        return {
          ok: true,
          value: await withOperatorAccessSync(
            registry,
            adapter,
            ownerCtxLive,
            applied.value as Record<string, unknown>,
          ),
        };
      }
      return { ok: true, value: applied.value };
    },
  };
}

/**
 * After an approved users.* change (or role deletion, which can strip a
 * user's last role): bring the cloud identity gate (Google IAP) in line and
 * fold the outcome into the tool result. A result naming a `userId` syncs that
 * user; one without (a role proposal) re-syncs every user. A failed sync stays
 * `ok: true` — the user change IS applied, and reporting a failure would send
 * the AI re-proposing it — but carries a `warning` the AI must relay, with
 * the next step, so the operator never finds out from a 403.
 */
async function withOperatorAccessSync(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ownerCtxLive: ExecutionContext,
  applied: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const userId = applied.userId;
  // System kind clears the self-or-system RLS on `users` (the Owner ctx would
  // only see its own row); actorId stays the approving Owner for the audit.
  const synced = await execute(
    registry,
    adapter,
    { ...ownerCtxLive, actorKind: "system" },
    "users.sync_operator_access",
    typeof userId === "string" ? { userIds: [userId] } : { allUsers: true },
  );
  const sync: OperatorAccessSync = synced.ok
    ? (synced.value as OperatorAccessSync)
    : {
        status: "failed",
        target: "the admin's identity gate",
        changes: [],
        error: describePersistError(synced.error),
        nextStep: `If it keeps failing, report it with \`bug_report\`. ${RESYNC_HINT}`,
      };
  const message = describeOperatorAccessSync(sync);
  if (sync.status === "failed") {
    return { ...applied, operatorAccess: sync, warning: `${message} Tell the operator this.` };
  }
  return { ...applied, operatorAccess: sync, ...(message ? { note: message } : {}) };
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
