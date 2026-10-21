// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #970 — what one run of the operator-access sync job tells the
 * admin besides "exit 0 / exit 1": which members Google refused, and
 * whether anything else went wrong.
 *
 * A Caelo user whose email has no Google account can never pass IAP, and
 * Google refuses to grant them (google-iam.ts, #955). Before, every such
 * user turned every run into "failed", and /settings/users said "IAP may
 * not match this list" although every other member was applied. Now:
 *
 *   - refused members only        → `succeeded_with_warnings` (exit 0);
 *     /settings/users names them, with Delete / Change email;
 *   - any other error             → `failed` (exit 1), refused members
 *     still listed;
 *   - nothing                     → `succeeded`.
 *
 * The job writes the report to `operator_access_sync_runs` (migration 0335)
 * through `users.record_operator_access_run`, keyed by its Cloud Run
 * execution, and the admin reads it for the execution it started or the
 * latest one.
 */

import { z } from "zod";

/** A run's outcome (the table's CHECK). */
export const SYNC_RUN_OUTCOMES = ["succeeded", "succeeded_with_warnings", "failed"] as const;
export type SyncRunOutcome = (typeof SYNC_RUN_OUTCOMES)[number];

/** The outcome of a run from what it ran into. */
export function classifySyncRun(input: {
  /** Emails Google has no account for (granted to nobody). */
  readonly refusedMembers: readonly string[];
  /** Every other error the run logged. */
  readonly errorCount: number;
}): SyncRunOutcome {
  if (input.errorCount > 0) return "failed";
  return input.refusedMembers.length > 0 ? "succeeded_with_warnings" : "succeeded";
}

/** The email of an IAM `user:` member, or null for any other principal. */
export function refusedEmail(member: string): string | null {
  return member.startsWith("user:") ? member.slice("user:".length).toLowerCase() : null;
}

/** One run's report as the job records it. */
export const syncRunReportSchema = z
  .object({
    /** Short Cloud Run execution id (`CLOUD_RUN_EXECUTION`). */
    execution: z.string().min(1).max(200),
    outcome: z.enum(SYNC_RUN_OUTCOMES),
    refusedMembers: z.array(z.string().email().max(254)).max(1000),
    errorCount: z.number().int().min(0),
    /** #967 — why the Google sign-in client was not (re)applied, with the fix; null when it was fine. */
    signInClientProblem: z.string().max(2000).nullable(),
  })
  .strict();
export type SyncRunReport = z.infer<typeof syncRunReportSchema>;

/** A recorded report, as the admin reads it. */
export const recordedSyncRunSchema = syncRunReportSchema.extend({ finishedAt: z.string() });
export type RecordedSyncRun = z.infer<typeof recordedSyncRunSchema>;

/** What to tell the operator about users Google refused (shared by the panel, the AI result and the docs). */
export function refusedMembersMessage(emails: readonly string[]): string {
  return `${emails.length === 1 ? "This user has" : "These users have"} no Google account and cannot sign in: ${emails.join(", ")}. Google refuses to let an address without a Google account through IAP. Next step: in /settings/users change the email to the person's Google account address (Gmail or Google Workspace), or delete the user.`;
}
