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
 * change (gated-tool `afterApply`, the /settings/users and /settings/roles
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
import {
  type RecordedSyncRun,
  recordedSyncRunSchema,
  refusedMembersMessage,
  syncRunReportSchema,
} from "../security/operator-access/run-report.js";
import { jsonbParam } from "../sql-helpers.js";

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
    /**
     * #970: users Google has no account for. The run applied everyone
     * else ("done with warnings"); these cannot sign in. Absent = none.
     */
    refusedMembers: z.array(z.string()).optional(),
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
    /** #970: refused users, when the failed run got as far as reporting them. */
    refusedMembers: z.array(z.string()).optional(),
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

/** Keep this many days of run reports; older ones are pruned on every insert. */
const RUN_REPORT_RETENTION_DAYS = 30;

/**
 * `users.record_operator_access_run` (#970): the sync job's report of one
 * run (which members Google refused, other errors, a sign-in client
 * problem). Written with the job's database role, which may insert here
 * and prune old reports, nothing else (migration 0341).
 */
export const recordOperatorAccessRunOp = defineOperation({
  name: "users.record_operator_access_run",
  // Why system-only: written by the operator-access sync job (its own
  // service account and database role) about its own run; nobody else
  // knows what Google answered it.
  actorScope: ["system"],
  database: "cms_admin",
  input: syncRunReportSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO operator_access_sync_runs
        (execution, outcome, refused_members, error_count, sign_in_client_problem)
      VALUES (
        ${input.execution}, ${input.outcome}, ${jsonbParam(input.refusedMembers)},
        ${input.errorCount}, ${input.signInClientProblem}
      )
    `);
    await tx.execute(sql`
      DELETE FROM operator_access_sync_runs
      WHERE finished_at < now() - make_interval(days => ${RUN_REPORT_RETENTION_DAYS})
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "users.record_operator_access_run",
      input: { execution: input.execution, outcome: input.outcome },
      succeeded: input.outcome !== "failed",
      resultSummary: `${input.outcome}; refused=${input.refusedMembers.length}; errors=${input.errorCount}`,
    });
    return ok({});
  },
});

/**
 * `users.operator_access_run` (#970): the report the sync job recorded for
 * `execution` (its latest attempt), or — without `execution` — the newest
 * report of any run; null when there is none.
 */
export const operatorAccessRunOp = defineOperation({
  name: "users.operator_access_run",
  // CLAUDE.md §11: read surface open to the AI ("why can't X sign in?").
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ execution: z.string().min(1).max(200).optional() }).strict(),
  output: z.object({ run: recordedSyncRunSchema.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT execution, outcome, refused_members, error_count, sign_in_client_problem, finished_at
      FROM operator_access_sync_runs
      ${input.execution === undefined ? sql`` : sql`WHERE execution = ${input.execution}`}
      ORDER BY finished_at DESC
      LIMIT 1
    `)) as unknown as {
      execution: string;
      outcome: RecordedSyncRun["outcome"];
      refused_members: string[];
      error_count: number;
      sign_in_client_problem: string | null;
      finished_at: string | Date;
    }[];
    const r = rows[0];
    return ok({
      run: r
        ? {
            execution: r.execution,
            outcome: r.outcome,
            refusedMembers: r.refused_members,
            errorCount: r.error_count,
            signInClientProblem: r.sign_in_client_problem,
            finishedAt:
              r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at),
          }
        : null,
    });
  },
});

/**
 * The job's report for `execution` (or the newest report when undefined);
 * throws (with the op error) when it cannot be read.
 */
async function readRunReport(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  execution: string | undefined,
): Promise<RecordedSyncRun | null> {
  const r = await execute(
    registry,
    adapter,
    ctx,
    "users.operator_access_run",
    execution === undefined ? {} : { execution },
  );
  if (!r.ok) throw new Error(`users.operator_access_run failed: ${JSON.stringify(r.error)}`);
  return (r.value as { run: RecordedSyncRun | null }).run;
}

/** The run finished without a report: a sync-job image older than the report table (#970). */
const NO_REPORT_HINT =
  "Update this install (Settings → Updates) so the sync job reports its runs, then re-sync.";

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
      result = await syncResult(registry, adapter, ctx, trigger.label, execution, run);
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
 * A finished (or still running) run as the sync result, folding in the
 * report the job recorded (#970): refused members only = synced with
 * `refusedMembers`; a finished run without a report fails loudly.
 */
async function syncResult(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  target: string,
  execution: string,
  run: {
    readonly state: "running" | "succeeded" | "failed" | "cancelled";
    readonly logsUrl: string;
  },
): Promise<OperatorAccessSync> {
  const { logsUrl } = run;
  if (run.state === "running") return { status: "running", target, execution, logsUrl };
  const report =
    run.state === "cancelled" ? null : await readRunReport(registry, adapter, ctx, execution);
  const refused = report && report.refusedMembers.length > 0 ? report.refusedMembers : null;
  if (run.state === "succeeded") {
    if (!report) {
      return {
        status: "failed",
        target,
        execution,
        logsUrl,
        error: `the sync job finished (execution ${execution}) but recorded no report, so Caelo cannot tell which users Google refused.`,
        nextStep: NO_REPORT_HINT,
      };
    }
    return {
      status: "synced",
      target,
      execution,
      logsUrl,
      ...(refused ? { refusedMembers: refused } : {}),
    };
  }
  return {
    status: "failed",
    target,
    execution,
    logsUrl,
    error: `the sync job ${run.state === "cancelled" ? "was cancelled" : "failed"} (execution ${execution}; its log says why: ${logsUrl}).${report?.signInClientProblem ? ` Google sign-in client: ${report.signInClientProblem}` : ""}`,
    nextStep: `Fix what the log names. ${RESYNC_HINT}`,
    ...(refused ? { refusedMembers: refused } : {}),
  };
}

/**
 * The latest run of the sync job (the hourly schedule's or the admin's), for
 * the /settings/users status line; `null` on installs without IAP.
 */
export async function latestOperatorAccessRun(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): Promise<
  | {
      status: "ok";
      target: string;
      run: Awaited<ReturnType<OperatorAccessTrigger["latest"]>>;
      /** #970: what that run reported (null while it runs, or when it recorded nothing). */
      report: RecordedSyncRun | null;
      /**
       * #970: the newest report any finished run recorded. Who Google
       * refused is known from it while the latest run is still running
       * (the hourly schedule, another tab's change), so the users page
       * never loses the list in between.
       */
      lastReport: RecordedSyncRun | null;
    }
  | { status: "error"; error: string; nextStep: string }
  | null
> {
  const trigger = currentTrigger();
  if (!trigger) return null;
  try {
    const run = await trigger.latest();
    const [report, lastReport] = await Promise.all([
      run && run.state !== "running"
        ? readRunReport(registry, adapter, ctx, run.execution)
        : Promise.resolve(null),
      readRunReport(registry, adapter, ctx, undefined),
    ]);
    return { status: "ok", target: trigger.label, run, report, lastReport };
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
 * /settings/users form actions so both read the same.
 */
export function describeOperatorAccessSync(sync: OperatorAccessSync): string | null {
  switch (sync.status) {
    case "not-applicable":
      return null;
    case "synced":
      return sync.refusedMembers?.length
        ? `${sync.target}: every other user is up to date. ${refusedMembersMessage(sync.refusedMembers)}`
        : `${sync.target}: up to date with the user list.`;
    case "running":
      return `${sync.target}: the sync is still running (execution ${sync.execution}); it finishes on its own — /settings/users shows the result.`;
    case "failed":
      return `The user change was saved, but ${sync.target} could NOT be updated: ${sync.error} Next step: ${sync.nextStep}${sync.refusedMembers?.length ? ` Also: ${refusedMembersMessage(sync.refusedMembers)}` : ""}`;
  }
}
