// SPDX-License-Identifier: MPL-2.0

import { externalArtifactDigest } from "@caelo-cms/plugin-sandbox";
import { sql } from "drizzle-orm";
import type { AuthorDispatchContext, LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { withExternalAuthorization } from "./external-authorization.js";

interface ApprovalBindingInput {
  readonly plugin: LoadedPlugin;
  readonly infra: PluginHostInfra;
  readonly authorContext?: AuthorDispatchContext;
  readonly toolName: string;
  readonly operationName: string;
  readonly toolCallId?: string;
  readonly args: unknown;
}

/** Host metadata only; no raw arguments or author content are persisted here. */
function binding(input: ApprovalBindingInput) {
  const { plugin, authorContext, toolCallId } = input;
  const approval = plugin.externalApproval;
  const branch = authorContext?.actor.chatBranchId;
  if (!approval || !branch || !authorContext || !toolCallId || toolCallId.length > 256)
    throw new Error("ExternalToolApprovalBindingRequired");
  if (authorContext.actor.actorKind !== "human" && authorContext.actor.actorKind !== "ai")
    throw new Error("ExternalToolApprovalAuthorRequired");
  const tool = plugin.definition.tools?.find((t) => t.name === input.toolName);
  if (!tool?.approvalMode || tool.operationName !== input.operationName)
    throw new Error("ExternalToolApprovalDeclarationChanged");
  return {
    branch,
    toolCallId,
    operator: authorContext.operatorActorId,
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

/** Called before presenting the approval card, using the catalogue's frozen plugin. */
export async function recordExternalToolApproval(input: ApprovalBindingInput): Promise<void> {
  const b = binding(input);
  await withExternalAuthorization(input.plugin, input.infra, async (tx) => {
    await tx.execute(sql`
      INSERT INTO plugin_tool_approval_bindings
        (plugin_id, chat_branch_id, tool_call_id, operator_actor_id, binding_digest)
      VALUES (${input.plugin.pluginId}::uuid, ${b.branch}::uuid, ${b.toolCallId},
        ${b.operator}::uuid, ${b.digest}) ON CONFLICT DO NOTHING
    `);
    const rows = (await tx.execute(sql`
      SELECT binding_digest FROM plugin_tool_approval_bindings
      WHERE plugin_id=${input.plugin.pluginId}::uuid AND chat_branch_id=${b.branch}::uuid
        AND tool_call_id=${b.toolCallId} AND operator_actor_id=${b.operator}::uuid
    `)) as unknown as { binding_digest: string }[];
    if (rows[0]?.binding_digest !== b.digest) throw new Error("ExternalToolApprovalBindingChanged");
  });
}

/** SDK approval alone cannot authorize a replacement installation or altered call. */
export async function assertExternalToolApproval(input: ApprovalBindingInput): Promise<void> {
  const b = binding(input);
  await withExternalAuthorization(input.plugin, input.infra, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT binding_digest FROM plugin_tool_approval_bindings
      WHERE plugin_id=${input.plugin.pluginId}::uuid AND chat_branch_id=${b.branch}::uuid
        AND tool_call_id=${b.toolCallId} AND operator_actor_id=${b.operator}::uuid
    `)) as unknown as { binding_digest: string }[];
    if (rows[0]?.binding_digest !== b.digest) throw new Error("ExternalToolApprovalBindingChanged");
  });
}
