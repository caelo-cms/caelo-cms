// SPDX-License-Identifier: MPL-2.0

/**
 * The Owner's automatic-update policy (epic #696, maintainer decision 2):
 * which kinds of release install on their own (security fixes / patch /
 * minor — never major before 1.0), stable channel only, a maintenance
 * window, a soak period, and the pause a failed automatic install sets.
 *
 * Phase 2 stores and enforces it in the upgrader job (it refuses an
 * automatic request the policy does not allow); Phase 5's scheduler is what
 * queues automatic requests from it.
 *
 * `get` is open to the AI (it may explain the policy); `set` is human-only
 * with the Owner permission and a fresh Google sign-in (decision 4: every
 * policy change is a step-up action).
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok, type StoredUpdatePolicy, updatePolicySchema } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditFromCtx } from "../audit.js";
import {
  consumeStepUp,
  guardedActionRefusal,
  sessionHashSchema,
} from "../security/step-up/gate.js";

const storedPolicySchema = z.object({
  mode: z.enum(["off", "notify", "auto"]),
  autoSecurity: z.boolean(),
  autoPatch: z.boolean(),
  autoMinor: z.boolean(),
  channel: z.enum(["stable", "rc", "beta", "alpha"]),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  windowTimezone: z.string(),
  soakHours: z.number(),
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  pausedAt: z.string().nullable(),
  updatedAt: z.string(),
});

/** Read the singleton policy row (migration 0267 seeds it). */
export async function readUpdatePolicy(tx: TransactionRunner): Promise<StoredUpdatePolicy | null> {
  const rows = (await tx.execute(sql`
    SELECT mode, auto_security, auto_patch, auto_minor, channel,
           to_char(window_start, 'HH24:MI') AS window_start,
           to_char(window_end, 'HH24:MI') AS window_end,
           window_timezone, soak_hours, paused, paused_reason, paused_at, updated_at
      FROM platform_update_policy WHERE id = 1
  `)) as unknown as {
    mode: StoredUpdatePolicy["mode"];
    auto_security: boolean;
    auto_patch: boolean;
    auto_minor: boolean;
    channel: StoredUpdatePolicy["channel"];
    window_start: string | null;
    window_end: string | null;
    window_timezone: string;
    soak_hours: number;
    paused: boolean;
    paused_reason: string | null;
    paused_at: Date | string | null;
    updated_at: Date | string;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    mode: r.mode,
    autoSecurity: r.auto_security,
    autoPatch: r.auto_patch,
    autoMinor: r.auto_minor,
    channel: r.channel,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    windowTimezone: r.window_timezone,
    soakHours: r.soak_hours,
    paused: r.paused,
    pausedReason: r.paused_reason,
    pausedAt: r.paused_at === null ? null : new Date(r.paused_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const MISSING_ROW =
  "platform_update_policy has no row (id = 1); migration 0267 seeds it — re-run the database migrations.";

export const platformUpdatePolicyGetOp = defineOperation({
  name: "platform_update_policy.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: storedPolicySchema,
  handler: async (_ctx, _input, tx) => {
    const policy = await readUpdatePolicy(tx);
    if (!policy) {
      return err({
        kind: "HandlerError",
        operation: "platform_update_policy.get",
        message: MISSING_ROW,
      });
    }
    return ok(policy);
  },
});

export const platformUpdatePolicySetOp = defineOperation({
  name: "platform_update_policy.set",
  // Why human-only: decides what installs without anyone clicking — a
  // deployment decision (CLAUDE.md §2) and a step-up action (#696 decision 4).
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      policy: updatePolicySchema,
      /** Lift the pause a failed automatic install set. */
      resume: z.boolean().optional(),
      sessionHash: sessionHashSchema,
    })
    .strict(),
  output: storedPolicySchema,
  handler: async (ctx, input, tx) => {
    const op = "platform_update_policy.set";
    const refusal = await guardedActionRefusal(tx, ctx, {
      operation: "change the update policy",
      permission: "platform.update",
      sessionHash: input.sessionHash,
    });
    if (refusal) return err({ kind: "HandlerError", operation: op, message: refusal });
    const p = input.policy;
    await tx.execute(sql`
      UPDATE platform_update_policy SET
        mode = ${p.mode}, auto_security = ${p.autoSecurity}, auto_patch = ${p.autoPatch},
        auto_minor = ${p.autoMinor}, channel = ${p.channel},
        window_start = ${p.windowStart}::time, window_end = ${p.windowEnd}::time,
        window_timezone = ${p.windowTimezone}, soak_hours = ${p.soakHours},
        paused = CASE WHEN ${input.resume === true} THEN false ELSE paused END,
        paused_reason = CASE WHEN ${input.resume === true} THEN NULL ELSE paused_reason END,
        paused_at = CASE WHEN ${input.resume === true} THEN NULL ELSE paused_at END,
        updated_by = ${ctx.actorId}::uuid, updated_at = now()
      WHERE id = 1
    `);
    const stored = await readUpdatePolicy(tx);
    if (!stored) return err({ kind: "HandlerError", operation: op, message: MISSING_ROW });
    await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { policy: p, resume: input.resume === true },
      succeeded: true,
      resultSummary: `mode=${p.mode} security=${p.autoSecurity} patch=${p.autoPatch} minor=${p.autoMinor}`,
    });
    return ok(stored);
  },
});
