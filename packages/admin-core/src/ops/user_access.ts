// SPDX-License-Identifier: MPL-2.0

/**
 * `users.sync_operator_access` — keep the cloud identity gate in front of the
 * admin (Google IAP on `gcp` / `gcp-firebase`, CLAUDE.md §11.B Tier 2) in step
 * with Caelo's own user list.
 *
 * Without it, an Owner-approved `propose_create_user` produces an account its
 * owner can never use: IAP answers 403 before the login page loads, and only
 * the provisioning Owner was ever allowlisted. Likewise a deleted user would
 * keep passing IAP (and signing MCP credentials) until someone edited IAM.
 *
 * The rule, per email address: a principal may pass IAP iff some non-deleted
 * user with that email holds at least one role. Callers run this AFTER the
 * user change committed (gated-tool `afterApply`, the /security/users form
 * actions) — a cloud call must not hold the write's transaction open, and a
 * failed sync must not undo an approved change. A failure is never silent:
 * it comes back as `status: "failed"` with the next step, and is audited as
 * a failed op.
 *
 * Non-IAP installs (self-hosted, AWS, Azure) return `not-applicable`.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  gcpIapBackendFromEnv,
  type OperatorAccessBackend,
  OperatorAccessError,
} from "../security/operator-access/gcp-iap.js";

let backendOverride: { backend: OperatorAccessBackend | null } | null = null;

/** Swap the cloud backend in tests (`null` argument restores env detection). */
export function setOperatorAccessBackendForTests(
  next: { backend: OperatorAccessBackend | null } | null,
): void {
  backendOverride = next;
}

function currentBackend(): OperatorAccessBackend | null {
  return backendOverride
    ? backendOverride.backend
    : gcpIapBackendFromEnv({
        CAELO_PROVIDER: process.env.CAELO_PROVIDER,
        CAELO_ENV: process.env.CAELO_ENV,
        K_SERVICE: process.env.K_SERVICE,
        CAELO_MCP_IAP_SERVICE_ACCOUNT: process.env.CAELO_MCP_IAP_SERVICE_ACCOUNT,
      });
}

const changeSchema = z.object({
  principal: z.string(),
  access: z.enum(["granted", "revoked"]),
});

export const operatorAccessSyncSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-applicable"), reason: z.string() }),
  z.object({ status: z.literal("synced"), target: z.string(), changes: z.array(changeSchema) }),
  z.object({
    status: z.literal("failed"),
    target: z.string(),
    /** Changes that went through before the failure. */
    changes: z.array(changeSchema),
    error: z.string(),
    nextStep: z.string(),
  }),
]);
export type OperatorAccessSync = z.infer<typeof operatorAccessSyncSchema>;

export const syncOperatorAccessOp = defineOperation({
  name: "users.sync_operator_access",
  // Why human-only: writes cloud IAM (who may reach the admin at all). The AI
  // reaches it only through the Owner-approved user tools, whose afterApply
  // runs it (elevated to system for the users RLS, attributed to the
  // approving Owner) after the approved change committed.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) }).strict(),
  output: operatorAccessSyncSchema,
  handler: async (ctx, input, tx) => {
    const backend = currentBackend();
    if (!backend) {
      return ok({
        status: "not-applicable" as const,
        reason: "The admin is not behind Google IAP on this install; Caelo's login is the gate.",
      });
    }
    const ids = sql.join(
      input.userIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    // `users` RLS is self-or-system, so a human ctx would see only its own
    // row and this would "sync" nothing while reporting success. Callers
    // run it as system; a missing row is a loud failure either way.
    const found = (await tx.execute(sql`
      SELECT id::text AS id FROM users WHERE id IN (${ids})
    `)) as unknown as { id: string }[];
    const missing = input.userIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "users.sync_operator_access",
        message: `user(s) not found: ${missing.join(", ")} — run this op with a system ctx (users RLS hides other users from a human actor).`,
      });
    }
    const rows = (await tx.execute(sql`
      WITH target AS (SELECT DISTINCT lower(email) AS email FROM users WHERE id IN (${ids}))
      SELECT t.email,
        EXISTS (
          SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id
          WHERE lower(u.email) = t.email AND u.deleted_at IS NULL
        ) AS allowed
      FROM target t
      ORDER BY t.email
    `)) as unknown as { email: string; allowed: boolean }[];

    const changes: z.infer<typeof changeSchema>[] = [];
    let result: OperatorAccessSync;
    try {
      for (const row of rows) {
        const principal = `user:${row.email}`;
        await backend.setAccess(principal, row.allowed);
        changes.push({ principal, access: row.allowed ? "granted" : "revoked" });
      }
      result = { status: "synced", target: backend.label, changes };
    } catch (e) {
      result = {
        status: "failed",
        target: backend.label,
        changes,
        error: e instanceof Error ? e.message : String(e),
        nextStep:
          e instanceof OperatorAccessError
            ? e.nextStep
            : "Approve the change again; if it keeps failing, report it with `bug_report`.",
      };
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.sync_operator_access",
      input,
      succeeded: result.status === "synced",
      resultSummary:
        result.status === "synced"
          ? changes.map((c) => `${c.access} ${c.principal}`).join("; ") || "(no users)"
          : `failed: ${result.status === "failed" ? result.error : ""}`.slice(0, 500),
    });
    return ok(result);
  },
});

/**
 * One operator-facing sentence for a sync result, or `null` when there is
 * nothing to say (not applicable). Shared by the chat tool result and the
 * /security/users form actions so both read the same.
 */
export function describeOperatorAccessSync(sync: OperatorAccessSync): string | null {
  if (sync.status === "not-applicable") return null;
  const done = sync.changes
    .map((c) => `${c.access === "granted" ? "allowed" : "removed"} ${c.principal.slice(5)}`)
    .join(", ");
  if (sync.status === "synced") {
    return done ? `${sync.target}: ${done}.` : `${sync.target}: already up to date.`;
  }
  return `The user change was saved, but ${sync.target} could NOT be updated: ${sync.error} Next step: ${sync.nextStep}`;
}
