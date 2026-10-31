// SPDX-License-Identifier: MPL-2.0

/**
 * The Owner's automatic-update policy (epic #696, maintainer decision 2):
 * which kinds of release install on their own (security fixes / patch /
 * minor — never major before 1.0), stable channel only, a maintenance
 * window, a soak period, and the pause a failed automatic install sets.
 *
 * Phase 2 stores and enforces it in the upgrader job (it refuses an
 * automatic request the policy does not allow); Phase 5's scheduler
 * (platform-updates/scheduler.ts) queues automatic requests from it.
 *
 * `get` is open to the AI (it may explain the policy); `set`, `pause` and
 * `resume` are human-only with the Owner permission and a password
 * confirmation (decisions 4 + 6, #757: every policy change is a step-up action).
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import {
  err,
  ok,
  type StoredUpdatePolicy,
  UPDATE_POLICY_CHANNELS,
  UPDATE_POLICY_MODES,
  updatePolicySchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditFromCtx } from "../audit.js";
import {
  consumeStepUp,
  guardedActionRefusal,
  sessionHashSchema,
} from "../security/step-up/gate.js";

const storedPolicySchema = z.object({
  mode: z.enum(UPDATE_POLICY_MODES),
  autoSecurity: z.boolean(),
  autoPatch: z.boolean(),
  autoMinor: z.boolean(),
  autoConverge: z.boolean(),
  channel: z.enum(UPDATE_POLICY_CHANNELS),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  windowTimezone: z.string(),
  soakHours: z.number(),
  securitySoakHours: z.number(),
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  pausedAt: z.string().nullable(),
  pausedUntil: z.string().nullable(),
  pausedByOwner: z.boolean(),
  updatedAt: z.string(),
});

/** Read the singleton policy row (migration 0267 seeds it). */
export async function readUpdatePolicy(tx: TransactionRunner): Promise<StoredUpdatePolicy | null> {
  const rows = (await tx.execute(sql`
    SELECT mode, auto_security, auto_patch, auto_minor, auto_converge, channel,
           to_char(window_start, 'HH24:MI') AS window_start,
           to_char(window_end, 'HH24:MI') AS window_end,
           window_timezone, soak_hours, security_soak_hours, paused, paused_reason,
           paused_at, paused_until, paused_by IS NOT NULL AS paused_by_owner, updated_at
      FROM platform_update_policy WHERE id = 1
  `)) as unknown as {
    mode: StoredUpdatePolicy["mode"];
    auto_security: boolean;
    auto_patch: boolean;
    auto_minor: boolean;
    auto_converge: boolean;
    channel: StoredUpdatePolicy["channel"];
    window_start: string | null;
    window_end: string | null;
    window_timezone: string;
    soak_hours: number;
    security_soak_hours: number;
    paused: boolean;
    paused_reason: string | null;
    paused_at: Date | string | null;
    paused_until: Date | string | null;
    paused_by_owner: boolean;
    updated_at: Date | string;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    mode: r.mode,
    autoSecurity: r.auto_security,
    autoPatch: r.auto_patch,
    autoMinor: r.auto_minor,
    autoConverge: r.auto_converge,
    channel: r.channel,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    windowTimezone: r.window_timezone,
    soakHours: r.soak_hours,
    securitySoakHours: r.security_soak_hours,
    paused: r.paused,
    pausedReason: r.paused_reason,
    pausedAt: r.paused_at === null ? null : new Date(r.paused_at).toISOString(),
    pausedUntil: r.paused_until === null ? null : new Date(r.paused_until).toISOString(),
    pausedByOwner: r.paused_by_owner,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const MISSING_ROW =
  "platform_update_policy has no row (id = 1); migration 0267 seeds it — re-run the database migrations.";

export const platformUpdatePolicyGetOp = defineOperation({
  name: "platform_update_policy.get",
  readScope: "request",
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
  readScope: "request",
  // Why human-only: decides what installs without anyone clicking — a
  // deployment decision (CLAUDE.md §2) and a step-up action (#696 decision 4).
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ policy: updatePolicySchema, sessionHash: sessionHashSchema }).strict(),
  output: storedPolicySchema,
  handler: async (ctx, input, tx) => {
    const op = "platform_update_policy.set";
    const refusal = await guardedActionRefusal(tx, ctx, {
      operation: "change the update policy",
      permission: "platform.update",
      sessionHash: input.sessionHash,
      purpose: "update_policy",
    });
    if (refusal) return err({ kind: "HandlerError", operation: op, message: refusal });
    const p = input.policy;
    // The pause is its own action (pause / resume below), so saving the
    // policy never lifts a pause by accident.
    await tx.execute(sql`
      UPDATE platform_update_policy SET
        mode = ${p.mode}, auto_security = ${p.autoSecurity}, auto_patch = ${p.autoPatch},
        auto_minor = ${p.autoMinor}, auto_converge = ${p.autoConverge}, channel = ${p.channel},
        window_start = ${p.windowStart}::time, window_end = ${p.windowEnd}::time,
        window_timezone = ${p.windowTimezone}, soak_hours = ${p.soakHours},
        security_soak_hours = ${p.securitySoakHours},
        updated_by = ${ctx.actorId}::uuid, updated_at = now()
      WHERE id = 1
    `);
    const stored = await readUpdatePolicy(tx);
    if (!stored) return err({ kind: "HandlerError", operation: op, message: MISSING_ROW });
    await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { policy: p },
      succeeded: true,
      resultSummary: `mode=${p.mode} security=${p.autoSecurity} patch=${p.autoPatch} minor=${p.autoMinor} converge=${p.autoConverge} soak=${p.soakHours}h/${p.securitySoakHours}h`,
    });
    return ok(stored);
  },
});

/** Longest an Owner pause may run with an end date (a year; longer = indefinitely). */
const MAX_PAUSE_DAYS = 366;

export const platformUpdatePolicyPauseOp = defineOperation({
  name: "platform_update_policy.pause",
  readScope: "request",
  // Why human-only: a change to the update policy (#696 decisions 4 + 6:
  // pausing is step-up gated like every policy change).
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      /** ISO time the pause ends; null = until the Owner resumes. */
      until: z.string().datetime({ offset: true }).nullable(),
      reason: z.string().trim().max(500).optional(),
      sessionHash: sessionHashSchema,
    })
    .strict(),
  output: storedPolicySchema,
  handler: async (ctx, input, tx) => {
    const op = "platform_update_policy.pause";
    const refusal = await guardedActionRefusal(tx, ctx, {
      operation: "pause automatic updates",
      permission: "platform.update",
      sessionHash: input.sessionHash,
      purpose: "update_policy",
    });
    if (refusal) return err({ kind: "HandlerError", operation: op, message: refusal });
    if (input.until !== null) {
      const ms = Date.parse(input.until) - Date.now();
      if (ms <= 0) {
        return err({
          kind: "HandlerError",
          operation: op,
          message:
            "The pause must end in the future. Pick a later date, or pause until you resume.",
        });
      }
      if (ms > MAX_PAUSE_DAYS * 86_400_000) {
        return err({
          kind: "HandlerError",
          operation: op,
          message: `A dated pause can last at most ${MAX_PAUSE_DAYS} days. Pause until you resume instead.`,
        });
      }
    }
    const reason = input.reason?.length ? input.reason : "Paused by the Owner.";
    await tx.execute(sql`
      UPDATE platform_update_policy SET
        paused = true, paused_at = now(), paused_reason = ${reason},
        paused_until = ${input.until}::timestamptz, paused_by = ${ctx.actorId}::uuid,
        updated_by = ${ctx.actorId}::uuid, updated_at = now()
      WHERE id = 1
    `);
    const stored = await readUpdatePolicy(tx);
    if (!stored) return err({ kind: "HandlerError", operation: op, message: MISSING_ROW });
    await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { until: input.until, reason },
      succeeded: true,
      resultSummary: input.until ? `paused until ${input.until}` : "paused until resumed",
    });
    return ok(stored);
  },
});

export const platformUpdatePolicyResumeOp = defineOperation({
  name: "platform_update_policy.resume",
  readScope: "request",
  // Why human-only: lifts a pause — after a failed automatic install the
  // Owner decides when unattended installs may run again (#696 decision 6).
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ sessionHash: sessionHashSchema }).strict(),
  output: storedPolicySchema,
  handler: async (ctx, input, tx) => {
    const op = "platform_update_policy.resume";
    const refusal = await guardedActionRefusal(tx, ctx, {
      operation: "resume automatic updates",
      permission: "platform.update",
      sessionHash: input.sessionHash,
      purpose: "update_policy",
    });
    if (refusal) return err({ kind: "HandlerError", operation: op, message: refusal });
    const before = await readUpdatePolicy(tx);
    if (!before) return err({ kind: "HandlerError", operation: op, message: MISSING_ROW });
    if (!before.paused) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: "Automatic updates are not paused; nothing to resume.",
      });
    }
    await tx.execute(sql`
      UPDATE platform_update_policy SET
        paused = false, paused_at = NULL, paused_reason = NULL, paused_until = NULL,
        paused_by = NULL, updated_by = ${ctx.actorId}::uuid, updated_at = now()
      WHERE id = 1
    `);
    const stored = await readUpdatePolicy(tx);
    if (!stored) return err({ kind: "HandlerError", operation: op, message: MISSING_ROW });
    await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: {},
      succeeded: true,
      resultSummary: `resumed (was: ${before.pausedReason ?? "paused"})`.slice(0, 200),
    });
    return ok(stored);
  },
});
