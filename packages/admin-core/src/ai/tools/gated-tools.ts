// SPDX-License-Identifier: MPL-2.0

/**
 * Gated tools — SDK-executed, human-approval-gated (CLAUDE.md §11.A, Plan B).
 *
 * A gated tool (any tool whose registry definition carries `gated`, set by
 * `makeProposeTool`) is the SDK-native replacement for the old
 * `propose_*` + `/settings/pending` Approve dance: the AI calls the action
 * directly, but the SDK PAUSES on a `tool-approval-request` before running the
 * tool's `execute`. The Owner approves in-chat; the SDK then runs `execute`,
 * which chains the existing per-domain machinery:
 *
 *   1. `<domain>.propose_<action>` (AI ctx) — writes the pending row, computes
 *      the preview jsonb, records audit;
 *   2. `<domain>.execute_proposal({proposalId})` (Owner live ctx) — applies the
 *      real mutation, exactly as the /settings/pending Approve did.
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
import { untrustedToolResult } from "@caelo-cms/shared";
import { executeBuild } from "../../build-carrier/carry.js";
import { BUILD_ORDER_KINDS, type BuildOpName } from "../../build-carrier/order.js";
import {
  approverPermissionsOf,
  isApproverPermissionRefusal,
} from "../../ops/_approver-permission.js";
import { describeOperatorAccessSync, syncOperatorAccess } from "../../ops/user_access.js";
import { describePersistError } from "../chat-runner/persistence.js";
import type { FilteredTool } from "../chat-runner/tool-catalogue.js";
import { approvedCallRunsLive, approvedPluginInvocation } from "../plugin-invocation.js";
import { credentialFreeResult } from "./credential-free-result.js";

/**
 * What the model reads first in a gated tool's success result. The bare op
 * output (`{kind:"accept", accepted:4}`) left the model believing its
 * proposal still waited for a click — the propose tools' own description
 * says "the Owner approves" — so it told the operator to approve something
 * already applied and parked follow-up work behind it (PR #624 real-AI run).
 */
/**
 * The build op an executor runs, when it builds (#1574: `deploy.execute_proposal`,
 * `quality_audits.execute_proposal`, …), else null.
 */
function buildExecutor(op: string): BuildOpName | null {
  return op !== "stage" && (BUILD_ORDER_KINDS as readonly string[]).includes(op)
    ? (op as BuildOpName)
    : null;
}

const APPLIED_STATUS =
  "APPROVED by the operator in this chat and APPLIED — nothing is pending any more; do not ask for approval again.";

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
      //    #1361 — an executor that builds (an approved Publish live,
      //    rollback or publish anyway) runs as a carried build (#1574). The
      //    turn waits for it as before, but the build runs inside the
      //    request its carrier holds open: a tab closed mid-build stops the
      //    turn, not the build, and on request-billed CPU a build left
      //    without any request would stall.
      const build = buildExecutor(gated.executeOp);
      const applied = build
        ? await executeBuild({ registry, adapter }, ownerCtxLive, build, { proposalId })
        : await execute(registry, adapter, ownerCtxLive, gated.executeOp, { proposalId });
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
      // #971 — from here on only the AI-visible shape of the output exists:
      // a credential the apply produced is a handoff the approver collects
      // in the admin, never a value the model (or an MCP client) reads.
      // A build that had no carrier ran inside this turn's request instead,
      // and says so: the operator must keep the tab open next time.
      const carrierWarning = "warning" in applied ? applied.warning : undefined;
      const appliedValue = credentialFreeResult(
        tool.name,
        carrierWarning
          ? { ...(applied.value as Record<string, unknown>), warning: carrierWarning }
          : applied.value,
      );
      // 3. Post-commit step, if the domain declared one. The apply
      //    transaction is closed by now, which is the whole reason this
      //    is not folded into `execute_proposal`.
      if (gated.afterApply === "load-activated-plugin") {
        const slug = (appliedValue as { slug?: string }).slug;
        if (slug) {
          const live = await loadActivatedPlugin(slug);
          if (!live.loaded) {
            // The row IS active; only the in-process load failed. Say so
            // precisely rather than reporting a clean success the
            // operator would find untrue, or a failure that would send
            // them re-approving something already applied.
            return {
              ok: true,
              status: APPLIED_STATUS,
              value: {
                ...(appliedValue as Record<string, unknown>),
                loadedIntoHost: false,
                warning: `"${slug}" is activated but could not be loaded into the running host (${live.reason}). It will load on the next restart; do not use its tools before then.`,
              },
            };
          }
          return {
            ok: true,
            status: APPLIED_STATUS,
            value: {
              ...(appliedValue as Record<string, unknown>),
              loadedIntoHost: true,
              note: "The plugin is running. Its tools and skills become available to you on your NEXT turn — this turn's tool list was fixed before the approval.",
            },
          };
        }
      }
      if (gated.afterApply === "redirects-go-live-now") {
        const saved = appliedValue as {
          goLive?: string;
          changes?: { fromPath: string; id: string; revision: number }[];
        };
        if (saved.goLive === "now" && saved.changes && saved.changes.length > 0) {
          // #1550 — the approver asked for these live now: Go live now as
          // the approver, after the apply committed (it reads the live
          // build's files and pushes to the hosting). A refusal leaves the
          // rules Staged and says why.
          // Bound to the changes the approval saved: a save in between is not
          // the change that was approved, and a rule already live as it is
          // has no change (its path would refuse the whole batch).
          const live = await execute(registry, adapter, ownerCtxLive, "redirects.go_live_now", {
            fromPaths: saved.changes.map((c) => c.fromPath),
            changes: saved.changes.map(({ id, revision }) => ({ id, revision })),
          });
          // A failed push is retried, a queued one waits for the release
          // holding the live site: either way the hosting lacks it for now.
          const notOnHosting = live.ok
            ? (live.value as { targets: { targetName: string; status: string }[] }).targets
                .filter((t) => t.status === "failed" || t.status === "queued")
                .map(
                  (t) =>
                    `${t.targetName} (${t.status === "failed" ? "push failed, retried" : "push queued behind a running release"})`,
                )
            : [];
          return {
            ok: true,
            status: APPLIED_STATUS,
            value: {
              ...(appliedValue as Record<string, unknown>),
              ...(live.ok
                ? {
                    wentLiveNow: true,
                    ...(notOnHosting.length > 0
                      ? {
                          warning: `Live in Caelo, but not on the hosting yet: ${notOnHosting.join(", ")}. Visitors keep getting the previous rule until it lands. Do not say it is live on the site yet.`,
                        }
                      : {}),
                  }
                : {
                    wentLiveNow: false,
                    warning: `Saved Staged, but it could not go live now: ${describePersistError(live.error)} It goes live with the next Publish live.`,
                  }),
            },
          };
        }
      }
      if (gated.afterApply === "sync-operator-access") {
        return {
          ok: true,
          status: APPLIED_STATUS,
          value: await withOperatorAccessSync(
            registry,
            adapter,
            ownerCtxLive,
            appliedValue as Record<string, unknown>,
          ),
        };
      }
      return { ok: true, status: APPLIED_STATUS, value: appliedValue };
    },
  };
}

/**
 * After an approved users.* change (or a role deletion, which can strip a
 * user's last role): start the operator-access sync job, which recomputes
 * Google IAP access for everyone, and fold the outcome into the tool result.
 * A failed sync stays `ok: true` — the user change IS applied, and reporting
 * a failure would send the AI re-proposing it — but carries a `warning` the
 * AI must relay, with the next step, so the operator never finds out from a
 * 403. The audit row is attributed to the approving Owner.
 */
async function withOperatorAccessSync(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ownerCtxLive: ExecutionContext,
  applied: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sync = await syncOperatorAccess(registry, adapter, ownerCtxLive);
  const message = describeOperatorAccessSync(sync);
  if (sync.status === "failed") {
    return { ...applied, operatorAccess: sync, warning: `${message} Tell the operator this.` };
  }
  // #970 — users Google has no account for are applied to nobody: the
  // change stands, but they cannot sign in until their address is a Google
  // account. A warning, so the AI relays it instead of reporting success.
  if (sync.status === "synced" && sync.refusedMembers?.length) {
    return {
      ...applied,
      operatorAccess: sync,
      warning: `${message} Tell the operator this. To fix it, propose_create_user with the person's Google account address and propose_delete_user for the old one, or let the Owner change the email in /settings/users.`,
    };
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
      // Live only for an approver who could publish it anyway (and not for a
      // draft-bound tool); otherwise the approved action stays on the
      // chat's branch until someone publishes.
      const canPublish = await operatorHasPermission(
        hostInfra(),
        hostSystemActorId(),
        approver,
        "deploy.trigger",
      );
      const spec = plugin?.definition.tools?.find((t) => t.name === tool.name) ?? {};
      const invocation =
        approvedCallRunsLive(canPublish, spec) || !chat.chatBranchId
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
      // #635 — plugin data may be visitor-written: data, never instructions.
      return { ok: true, value: untrustedToolResult(r.value) };
    },
  };
}
