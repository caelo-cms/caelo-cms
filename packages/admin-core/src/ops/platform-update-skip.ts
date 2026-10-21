// SPDX-License-Identifier: MPL-2.0

/**
 * "Skip this time" for a scheduled automatic install (#868).
 *
 *   platform_updates.skip_scheduled   the Owner keeps the scheduler from
 *                                     installing one release on its own
 *
 * The scheduled state of Settings → Updates says "vX installs automatically
 * on <date>". Skipping records vX on the scheduler row
 * (`platform_update_scheduler.skipped_version`, migration 0332); from then
 * on the scheduler's decision for vX is "offer it" instead of "install it"
 * (shared auto-update.ts), so the Owner can still install it by hand, and
 * the next newer release installs automatically again. The scheduler's
 * last decision is rewritten in the same transaction, so the page and the
 * AI stop saying "scheduled" at once instead of at the next tick.
 *
 * Human-only with the Owner permission and a password confirmation, like
 * every other change to what installs unattended (#696 decision 4, #757).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { CAELO_VERSION, err, isNewerVersion, ok, skippedInstallReason } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditFromCtx } from "../audit.js";
import {
  consumeStepUp,
  guardedActionRefusal,
  sessionHashSchema,
} from "../security/step-up/gate.js";

const OP = "platform_updates.skip_scheduled";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

const handlerError = (message: string) =>
  err({ kind: "HandlerError" as const, operation: OP, message });

export const platformUpdatesSkipScheduledOp = defineOperation({
  name: "platform_updates.skip_scheduled",
  // Why human-only: decides what installs unattended on this site, which
  // only the Owner does, confirmed with their password (#696 decision 4).
  // The AI explains the schedule (get_caelo_auto_update_status); it does
  // not change it.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      /** The release whose automatic install to skip (no leading v). */
      version: z.string().regex(VERSION, "expected a version like 0.11.0, without a leading v"),
      sessionHash: sessionHashSchema,
    })
    .strict(),
  output: z.object({ skippedVersion: z.string() }),
  handler: async (ctx, input, tx) => {
    const refusal = await guardedActionRefusal(tx, ctx, {
      operation: "skip an automatic Caelo update",
      permission: "platform.update",
      sessionHash: input.sessionHash,
      purpose: "update_policy",
    });
    if (refusal) return handlerError(refusal);
    if (!isNewerVersion(input.version, CAELO_VERSION)) {
      return handlerError(
        `This site already runs v${CAELO_VERSION}, so there is no automatic install of v${input.version} to skip. Reload Settings → Updates to see what is scheduled.`,
      );
    }
    // Queued or running: the install is under way, skipping it is too late.
    const inFlight = (await tx.execute(sql`
      SELECT 1 AS one FROM platform_update_requests
       WHERE target_version = ${input.version} AND status IN ('pending', 'running')
       LIMIT 1
    `)) as unknown as { one: number }[];
    if (inFlight.length > 0) {
      return handlerError(
        `The install of v${input.version} has already started, so it cannot be skipped any more. While it waits to start you can cancel it in Settings → Updates; a running install finishes or rolls back on its own.`,
      );
    }
    const rows = (await tx.execute(sql`
      UPDATE platform_update_scheduler
         SET skipped_version = ${input.version},
             skipped_by = ${ctx.actorId}::uuid,
             skipped_at = now(),
             -- The scheduler's next tick says the same; the page and the
             -- AI must not keep saying "scheduled" until then.
             last_action = CASE WHEN last_version = ${input.version} AND last_action IN ('wait', 'install')
                                THEN 'notify' ELSE last_action END,
             last_reason = CASE WHEN last_version = ${input.version} AND last_action IN ('wait', 'install')
                                THEN ${skippedInstallReason(input.version)} ELSE last_reason END,
             last_wait_until = CASE WHEN last_version = ${input.version} AND last_action IN ('wait', 'install')
                                    THEN NULL ELSE last_wait_until END
       WHERE id = 1
       RETURNING skipped_version
    `)) as unknown as { skipped_version: string }[];
    if (rows.length === 0) {
      return handlerError(
        "platform_update_scheduler has no row (id = 1); migration 0271 seeds it — re-run the database migrations.",
      );
    }
    await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: OP,
      input: { version: input.version },
      succeeded: true,
      resultSummary: `skipped the automatic install of v${input.version}`,
    });
    return ok({ skippedVersion: input.version });
  },
});
