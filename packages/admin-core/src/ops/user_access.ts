// SPDX-License-Identifier: MPL-2.0

/**
 * Operator access on Google IAP installs: keep who may pass the admin's
 * identity gate (CLAUDE.md §11.B Tier 2) and sign as `caelo-mcp` in step with
 * Caelo's user list.
 *
 * The rule, per email address: a principal may pass IAP iff some non-deleted
 * user with that email holds at least one role.
 *
 * The admin does not write that to Google itself. A dedicated Cloud Run job
 * (security/operator-access/sync-job.ts) running as its own service account
 * reads the user list through {@link operatorAccessMembersOp} with a
 * read-only database role and makes the two IAM bindings hold exactly that
 * (gcp-job-trigger.ts explains the trust boundary). The admin only starts
 * the job — {@link syncOperatorAccess}, called after an approved user or role
 * change (gated-tool `afterApply`, the /security/users and /security/roles
 * form actions) and by the "Re-sync" button — and records the outcome in the
 * audit log. A cloud schedule also runs it hourly, so a missed or failed run
 * heals on its own.
 *
 * A failure is never silent: it comes back as `status: "failed"` with the
 * next step and is audited as failed.
 *
 * Non-IAP installs (self-hosted, AWS, Azure) return `not-applicable`: their
 * identity proxies (Caddy forward_auth, ALB + Cognito, Easy Auth + Entra ID)
 * are allowlisted by group in the provider's IdP, which Caelo does not manage
 * yet — the Owner keeps that group in step by hand there.
 */

import {
  type DatabaseAdapter,
  defineOperation,
  execute,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  gcpJobTriggerFromEnv,
  OperatorAccessError,
  type OperatorAccessTrigger,
  RESYNC_HINT,
} from "../security/operator-access/gcp-job-trigger.js";

/**
 * `users.operator_access_members` — the emails that should pass IAP: every
 * non-deleted user holding at least one role. Read by the sync job with the
 * `operator_access_reader` database role, which may select exactly the
 * columns this query touches (migration 0239).
 */
export const operatorAccessMembersOp = defineOperation({
  name: "users.operator_access_members",
  // Why system-only: the input of the operator-access sync job, which runs
  // as a system actor with a read-only database role. Humans and the AI see
  // users through users.list.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ emails: z.array(z.string()) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT lower(u.email) AS email
      FROM users u
      WHERE u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)
      ORDER BY 1
    `)) as unknown as { email: string }[];
    return ok({ emails: rows.map((r) => r.email) });
  },
});

export const operatorAccessSyncSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-applicable"), reason: z.string() }),
  z.object({
    status: z.literal("synced"),
    target: z.string(),
    execution: z.string(),
    logsUrl: z.string(),
  }),
  z.object({
    /** Started but not finished within the wait; it finishes on its own. */
    status: z.literal("running"),
    target: z.string(),
    execution: z.string(),
    logsUrl: z.string(),
  }),
  z.object({
    status: z.literal("failed"),
    target: z.string(),
    execution: z.string().optional(),
    logsUrl: z.string().optional(),
    error: z.string(),
    nextStep: z.string(),
  }),
]);
export type OperatorAccessSync = z.infer<typeof operatorAccessSyncSchema>;

/** `users.record_operator_access_sync` — audit row for one triggered sync. */
export const recordOperatorAccessSyncOp = defineOperation({
  name: "users.record_operator_access_sync",
  // Why human-only: records the outcome of starting the operator-access
  // sync job, which happens only after an Owner-approved user/role change or
  // the Owner's Re-sync click (both run the recording themselves).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: operatorAccessSyncSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.record_operator_access_sync",
      input,
      succeeded: input.status !== "failed",
      resultSummary:
        input.status === "failed"
          ? `failed: ${input.error}`.slice(0, 500)
          : input.status === "not-applicable"
            ? "not-applicable"
            : `${input.status}: ${input.execution}`,
    });
    return ok({});
  },
});

let triggerOverride: { trigger: OperatorAccessTrigger | null } | null = null;

/** Swap the cloud trigger in tests (`null` argument restores env detection). */
export function setOperatorAccessTriggerForTests(
  next: { trigger: OperatorAccessTrigger | null } | null,
): void {
  triggerOverride = next;
}

function currentTrigger(): OperatorAccessTrigger | null {
  return triggerOverride
    ? triggerOverride.trigger
    : gcpJobTriggerFromEnv({
        CAELO_PROVIDER: process.env.CAELO_PROVIDER,
        CAELO_OPERATOR_ACCESS_JOB: process.env.CAELO_OPERATOR_ACCESS_JOB,
      });
}

/** How long a caller waits for the job before reporting it as still running. */
const WAIT_MS = 90_000;

/**
 * Start the sync job, wait for it (up to {@link WAIT_MS}) and record the
 * outcome. Runs OUTSIDE any transaction: a cloud call must not hold a
 * write's transaction open, and a failed sync must not undo an approved
 * change. `ctx` is the actor the audit row is attributed to.
 */
export async function syncOperatorAccess(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): Promise<OperatorAccessSync> {
  const trigger = currentTrigger();
  let result: OperatorAccessSync;
  if (!trigger) {
    result = {
      status: "not-applicable",
      reason: "The admin is not behind Google IAP on this install; Caelo's login is the gate.",
    };
  } else {
    let execution: string | undefined;
    try {
      execution = await trigger.start();
      const run = await trigger.wait(execution, WAIT_MS);
      result =
        run.state === "succeeded"
          ? { status: "synced", target: trigger.label, execution, logsUrl: run.logsUrl }
          : run.state === "running"
            ? { status: "running", target: trigger.label, execution, logsUrl: run.logsUrl }
            : {
                status: "failed",
                target: trigger.label,
                execution,
                logsUrl: run.logsUrl,
                error: `the sync job ${run.state === "cancelled" ? "was cancelled" : "failed"} (execution ${execution}; its log says why: ${run.logsUrl}).`,
                nextStep: `Fix what the log names. ${RESYNC_HINT}`,
              };
    } catch (e) {
      result = {
        status: "failed",
        target: trigger.label,
        ...(execution ? { execution } : {}),
        error: e instanceof Error ? e.message : String(e),
        nextStep:
          e instanceof OperatorAccessError
            ? e.nextStep
            : `If it keeps failing, report it with \`bug_report\`. ${RESYNC_HINT}`,
      };
    }
  }
  const recorded = await execute(
    registry,
    adapter,
    ctx,
    "users.record_operator_access_sync",
    result,
  );
  if (!recorded.ok && result.status !== "failed") {
    // The sync itself went through; say so, but don't hide that the audit
    // row is missing.
    return {
      status: "failed",
      target: result.status === "not-applicable" ? "audit log" : result.target,
      error: `the sync ran (${result.status}) but its audit row could not be written: ${JSON.stringify(recorded.error)}`,
      nextStep: "Report this with `bug_report`.",
    };
  }
  return result;
}

/**
 * The latest run of the sync job (the hourly schedule's or the admin's), for
 * the /security/users status line; `null` on installs without IAP.
 */
export async function latestOperatorAccessRun(): Promise<
  | { status: "ok"; target: string; run: Awaited<ReturnType<OperatorAccessTrigger["latest"]>> }
  | { status: "error"; error: string; nextStep: string }
  | null
> {
  const trigger = currentTrigger();
  if (!trigger) return null;
  try {
    return { status: "ok", target: trigger.label, run: await trigger.latest() };
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
      nextStep: e instanceof OperatorAccessError ? e.nextStep : RESYNC_HINT,
    };
  }
}

/**
 * One operator-facing sentence for a sync result, or `null` when there is
 * nothing to say (not applicable). Shared by the chat tool result and the
 * /security/users form actions so both read the same.
 */
export function describeOperatorAccessSync(sync: OperatorAccessSync): string | null {
  switch (sync.status) {
    case "not-applicable":
      return null;
    case "synced":
      return `${sync.target}: up to date with the user list.`;
    case "running":
      return `${sync.target}: the sync is still running (execution ${sync.execution}); it finishes on its own — /security/users shows the result.`;
    case "failed":
      return `The user change was saved, but ${sync.target} could NOT be updated: ${sync.error} Next step: ${sync.nextStep}`;
  }
}
