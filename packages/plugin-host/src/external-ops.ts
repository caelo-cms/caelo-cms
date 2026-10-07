// SPDX-License-Identifier: MPL-2.0

/**
 * Named operations the host uses to authorise externally installed
 * plugins (CMS_REQUIREMENTS §14.5, §14.7). The host never issues SQL for
 * a plugin: approval state, author permission and tool-approval
 * bindings are read and written through these, behind the Validator.
 *
 * All are system-only — they run on the host's behalf, never on a
 * plugin's or a person's.
 */

import { externalArtifactDigest } from "@caelo-cms/plugin-sandbox";
import {
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** Operation names, for the host's callers. */
export const EXTERNAL_OPS = {
  approval: "plugin_external.approval",
  operatorHasPermission: "plugin_external.operator_has_permission",
  recordToolBinding: "plugin_external.record_tool_binding",
  consumeToolBinding: "plugin_external.consume_tool_binding",
} as const;

/**
 * The approval state of an installed plugin's running artifact: whether
 * it is active, its digest, and the Owner receipts issued for exactly
 * that digest.
 */
const approvalOp = defineOperation({
  name: EXTERNAL_OPS.approval,
  // Why system-only: the host reads approval state to load and authorise
  // a plugin; nobody else needs it in this shape.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ pluginId: z.string().uuid() }).strict(),
  output: z.object({
    active: z.boolean(),
    artifactDigest: z.string().nullable(),
    manifest: z.unknown(),
    grants: z.array(z.object({ id: z.string(), capability: z.string() })),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT status, manifest_json, source_code FROM plugins WHERE id = ${input.pluginId}::uuid
    `)) as unknown as { status: string; manifest_json: unknown; source_code: string | null }[];
    const row = rows[0];
    if (!row || row.source_code === null) {
      return ok({ active: false, artifactDigest: null, manifest: null, grants: [] });
    }
    const artifactDigest = externalArtifactDigest(row.manifest_json, row.source_code);
    const grants = (await tx.execute(sql`
      SELECT g.id::text AS id, g.capability
      FROM plugin_capability_grants g
      JOIN plugin_installation_versions v
        ON v.plugin_id = g.plugin_id AND v.artifact_digest = g.artifact_digest
      WHERE g.plugin_id = ${input.pluginId}::uuid AND g.artifact_digest = ${artifactDigest}
        AND g.revoked_at IS NULL AND v.status = 'active'
      ORDER BY g.id
    `)) as unknown as { id: string; capability: string }[];
    return ok({
      active: row.status === "active",
      artifactDigest,
      manifest: row.manifest_json,
      grants,
    });
  },
});

/**
 * Whether the human a plugin call acts for holds a permission:
 * `content.write` to author (the precondition for author storage),
 * `deploy.trigger` to publish (an approved action goes live only for
 * someone who could publish it anyway), or whatever a plugin tool's
 * `requiredPermission` names (e.g. `settings.write`).
 */
const operatorHasPermissionOp = defineOperation({
  name: EXTERNAL_OPS.operatorHasPermission,
  // Why system-only: the host checks the operator a plugin call acts for.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      actorId: z.string().uuid(),
      permission: z.enum(["content.write", "settings.write", "deploy.trigger"]),
    })
    .strict(),
  output: z.object({ allowed: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = ${input.actorId}::uuid AND u.deleted_at IS NULL AND p.name = ${input.permission}
      ) AS allowed
    `)) as unknown as { allowed: boolean }[];
    return ok({ allowed: rows[0]?.allowed === true });
  },
});

/** How long an approval card stays redeemable. */
const BINDING_TTL = "7 days";

const bindingInput = z
  .object({
    pluginId: z.string().uuid(),
    toolCallId: z.string().min(1).max(256),
    operatorActorId: z.string().uuid(),
    bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Record the binding shown on an approval card (idempotent for the same call). */
const recordToolBindingOp = defineOperation({
  name: EXTERNAL_OPS.recordToolBinding,
  // Why system-only: the host records the binding before asking the Owner.
  actorScope: ["system"],
  database: "cms_admin",
  input: bindingInput.extend({ chatBranchId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    // Approvals expire: a rejected or abandoned card leaves its binding
    // behind, and nothing else would ever remove it.
    await tx.execute(sql`
      DELETE FROM plugin_tool_approval_bindings
      WHERE created_at < now() - ${BINDING_TTL}::interval
    `);
    await tx.execute(sql`
      INSERT INTO plugin_tool_approval_bindings
        (plugin_id, chat_branch_id, tool_call_id, operator_actor_id, binding_digest)
      VALUES (${input.pluginId}::uuid, ${input.chatBranchId}::uuid, ${input.toolCallId},
        ${input.operatorActorId}::uuid, ${input.bindingDigest})
      ON CONFLICT DO NOTHING
    `);
    const rows = (await tx.execute(sql`
      SELECT binding_digest FROM plugin_tool_approval_bindings
      WHERE plugin_id = ${input.pluginId}::uuid AND chat_branch_id = ${input.chatBranchId}::uuid
        AND tool_call_id = ${input.toolCallId}
        AND operator_actor_id = ${input.operatorActorId}::uuid
    `)) as unknown as { binding_digest: string }[];
    if (rows[0]?.binding_digest !== input.bindingDigest) {
      return err({
        kind: "HandlerError",
        operation: EXTERNAL_OPS.recordToolBinding,
        message: "ExternalToolApprovalBindingChanged: propose a fresh tool call",
      });
    }
    return ok({});
  },
});

/**
 * Redeem a binding: the approved call runs only if it matches exactly,
 * and the binding is deleted in the same step so the approval cannot be
 * used twice.
 */
const consumeToolBindingOp = defineOperation({
  name: EXTERNAL_OPS.consumeToolBinding,
  // Why system-only: the host redeems the approval it recorded.
  actorScope: ["system"],
  database: "cms_admin",
  input: bindingInput.extend({ chatBranchId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM plugin_tool_approval_bindings
      WHERE plugin_id = ${input.pluginId}::uuid AND chat_branch_id = ${input.chatBranchId}::uuid
        AND tool_call_id = ${input.toolCallId}
        AND operator_actor_id = ${input.operatorActorId}::uuid
        AND binding_digest = ${input.bindingDigest}
        AND created_at >= now() - ${BINDING_TTL}::interval
      RETURNING binding_digest
    `)) as unknown as { binding_digest: string }[];
    // A mismatched call (changed arguments, another operator) deletes
    // nothing, so it cannot burn the Owner's approval for the real call.
    if (rows.length !== 1) {
      return err({
        kind: "HandlerError",
        operation: EXTERNAL_OPS.consumeToolBinding,
        message:
          "ExternalToolApprovalBindingChanged: this approval was already used, or the installation or arguments changed — propose a fresh tool call",
      });
    }
    return ok({});
  },
});

const ALL = [approvalOp, operatorHasPermissionOp, recordToolBindingOp, consumeToolBindingOp];

/** Register the external-plugin operations (idempotent, like the storage ops). */
export function registerExternalPluginOps(registry: OperationRegistry): void {
  if (registry.has(EXTERNAL_OPS.approval)) return;
  // The registry stores every op as OperationDefinition<unknown, unknown>.
  for (const op of ALL) registry.register(op as OperationDefinition<unknown, unknown>);
}
