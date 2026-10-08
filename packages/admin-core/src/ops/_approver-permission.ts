// SPDX-License-Identifier: MPL-2.0

/**
 * #589 — who may APPROVE a §11.A gated action.
 *
 * The approval gate exists to obtain the decision of someone entitled to
 * make it. Every gated action is applied by an executor op
 * (`<domain>.execute_proposal` and friends) run as the human who clicked
 * Approve — in the chat (the SDK tool-approval resume runs it with the
 * clicking operator's context) or on a `/security/<domain>/pending` page.
 * Anyone who can open a chat (`content.read`) sees the in-chat card, so the
 * click alone proves nothing: the executor itself must check that the
 * approver holds the permission the equivalent panel action requires.
 *
 * `requiresApproverPermission` declares that permission AT the executor op
 * and enforces it inside the op's handler, so the chat path, the pending
 * pages and any future caller share one check. A refused approval returns
 * before the handler touches the proposal row, so the row stays `pending`
 * for someone who holds the permission. The declared permissions also ride
 * on the op definition (`approverPermissions`): the pending pages guard
 * their Approve action with the same list, and the CI guard asserts every
 * gated tool's executor declares one.
 */

import type { OperationDefinition, TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { err } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

import type { Permission } from "../permissions.js";

/**
 * Message prefix of a refused approval (the codebase-wide `permission_denied:`
 * shape), so the gated-tool execute can tell "this approver may not decide"
 * from a failed apply and say where the still-pending proposal waits.
 */
const APPROVER_PERMISSION_DENIED = "permission_denied";

/** An executor op that declares which permissions its approver must hold. */
export type ApprovalOperationDefinition<I, O> = OperationDefinition<I, O> & {
  /** Every one of these is required (AND). Never empty. */
  readonly approverPermissions: readonly [Permission, ...Permission[]];
};

/**
 * The permissions in `required` the human `actorId` does NOT hold through
 * any of their roles. A deleted or unknown user holds none.
 */
async function missingPermissions(
  tx: TransactionRunner,
  actorId: string,
  required: readonly Permission[],
): Promise<Permission[]> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT p.name FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE u.id = ${actorId}::uuid AND u.deleted_at IS NULL
  `)) as unknown as { name: string }[];
  const held = new Set(rows.map((r) => r.name));
  return required.filter((p) => !held.has(p));
}

/**
 * Whether `ctx` may approve: `system` always (workers, bootstrap, tests that
 * act as the platform), a human only when they hold every permission, any
 * other actor kind never — the AI must not approve its own proposal even if
 * an executor's actorScope were ever widened by mistake.
 */
async function approverRefusal(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  operation: string,
  required: readonly Permission[],
): Promise<string | null> {
  if (ctx.actorKind === "system") return null;
  if (ctx.actorKind !== "human") {
    return `${APPROVER_PERMISSION_DENIED}: only a human holding ${required.join(" + ")} can approve ${operation}.`;
  }
  const missing = await missingPermissions(tx, ctx.actorId, required);
  if (missing.length === 0) return null;
  return (
    `${APPROVER_PERMISSION_DENIED}: approving this needs the ${missing.join(" + ")} permission, ` +
    `which your role does not have. Nothing was applied and the proposal stays pending — ` +
    `ask someone who holds ${required.join(" + ")} (an Owner) to approve it.`
  );
}

/**
 * Declare + enforce the approver permission of a gated executor op. Wrap the
 * `defineOperation({...})` call directly so the permission sits next to the
 * op it protects.
 *
 * @example
 * export const executeRoleProposalOp = requiresApproverPermission(
 *   ["roles.manage"],
 *   defineOperation({ name: "roles.execute_proposal", ... }),
 * );
 */
export function requiresApproverPermission<I, O>(
  approverPermissions: readonly [Permission, ...Permission[]],
  op: OperationDefinition<I, O>,
): ApprovalOperationDefinition<I, O> {
  const inner = op.handler;
  return {
    ...op,
    approverPermissions,
    handler: async (ctx, input, tx) => {
      const refusal = await approverRefusal(tx, ctx, op.name, approverPermissions);
      if (refusal !== null) {
        return err({ kind: "HandlerError", operation: op.name, message: refusal });
      }
      return inner(ctx, input, tx);
    },
  };
}

/**
 * The approver permissions an op declares, or `null` when it declares none
 * (i.e. it is not a gated executor). Reads the registered definition, so it
 * is the single source for the pending pages and the CI guard.
 */
export function approverPermissionsOf(
  op: OperationDefinition<unknown, unknown>,
): readonly Permission[] | null {
  const declared = (op as Partial<ApprovalOperationDefinition<unknown, unknown>>)
    .approverPermissions;
  return declared && declared.length > 0 ? declared : null;
}

/** Whether a failed executor's message is an approver-permission refusal. */
export function isApproverPermissionRefusal(message: string): boolean {
  return message.startsWith(`${APPROVER_PERMISSION_DENIED}:`);
}
