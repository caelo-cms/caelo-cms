// SPDX-License-Identifier: MPL-2.0

/**
 * Bindings for an external plugin's approval-gated tool (§11.A). Before
 * the approval card is shown, the host records what the Owner is asked
 * to approve: the artifact, its receipts, the tool, the exact arguments
 * and the operator. The approved call then redeems that binding once —
 * a changed installation, changed arguments or a second use of the same
 * approval is refused.
 *
 * Only a digest is stored; no arguments or author content.
 */

import { externalArtifactDigest } from "@caelo-cms/plugin-sandbox";
import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { EXTERNAL_OPS, registerExternalPluginOps } from "./external-ops.js";

interface BindingSubject {
  readonly plugin: LoadedPlugin;
  readonly infra: PluginHostInfra;
  readonly toolName: string;
  readonly operationName: string;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
}

function bindingDigest(input: BindingSubject): { digest: string; toolCallId: string } {
  const approval = input.plugin.externalApproval;
  const toolCallId = input.toolCallId;
  if (!approval || !toolCallId || toolCallId.length > 256) {
    throw new Error("ExternalToolApprovalBindingRequired");
  }
  const tool = input.plugin.definition.tools?.find((t) => t.name === input.toolName);
  if (!tool?.approvalMode || tool.operationName !== input.operationName) {
    throw new Error("ExternalToolApprovalDeclarationChanged");
  }
  return {
    toolCallId,
    digest: externalArtifactDigest(
      {
        artifactDigest: approval.artifactDigest,
        grantIds: [...approval.grantIds].sort(),
        toolName: input.toolName,
        operationName: input.operationName,
        args: input.args,
      },
      "plugin-tool-approval-v1",
    ),
  };
}

async function run(input: BindingSubject, op: string, values: Record<string, unknown>) {
  const approval = input.plugin.externalApproval;
  if (!approval) throw new Error("ExternalToolApprovalBindingRequired");
  registerExternalPluginOps(input.infra.registry);
  const r = await execute(
    input.infra.registry,
    input.infra.adapter,
    { actorId: approval.systemActorId, actorKind: "system", requestId: "external-tool-binding" },
    op,
    values,
  );
  if (!r.ok) {
    throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
  }
}

/**
 * Record the binding before the approval card is shown. Called in the
 * chat, so the invocation carries the chat's branch and operator.
 */
export async function recordExternalToolApproval(
  input: BindingSubject & { readonly invocation: PluginInvocation },
): Promise<void> {
  const { invocation } = input;
  if (invocation.origin !== "chat" || !invocation.chatBranchId || !invocation.operatorActorId) {
    throw new Error("ExternalToolApprovalAuthorRequired");
  }
  const { digest, toolCallId } = bindingDigest(input);
  await run(input, EXTERNAL_OPS.recordToolBinding, {
    pluginId: input.plugin.pluginId,
    chatBranchId: invocation.chatBranchId,
    toolCallId,
    operatorActorId: invocation.operatorActorId,
    bindingDigest: digest,
  });
}

/**
 * Redeem the binding for the approved call, once, in the chat it was
 * recorded in. The approved invocation's actor is the human who clicked
 * Approve.
 */
export async function consumeExternalToolApproval(
  input: BindingSubject & {
    readonly invocation: PluginInvocation;
    /** The chat the card was shown in. */
    readonly chatBranchId: string | undefined;
  },
): Promise<void> {
  if (input.invocation.origin !== "approved") {
    throw new Error("ExternalToolApprovalRequired: run this tool through its approval card");
  }
  if (!input.chatBranchId) throw new Error("ExternalToolApprovalBindingRequired");
  const { digest, toolCallId } = bindingDigest(input);
  await run(input, EXTERNAL_OPS.consumeToolBinding, {
    pluginId: input.plugin.pluginId,
    chatBranchId: input.chatBranchId,
    toolCallId,
    operatorActorId: input.invocation.actorId,
    bindingDigest: digest,
  });
}
