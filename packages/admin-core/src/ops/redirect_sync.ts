// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — the redirect sync ops (deploy/redirect-sync.ts has the model).
 *
 *  redirects.sync_provider — push the redirects table to the hosting provider
 *                            of every staging / production target, without a
 *                            build. Runs after every redirects write, from the
 *                            retry worker and from Settings → Redirects' "Try
 *                            again".
 *  redirects.sync_status   — per target: is the provider serving the saved
 *                            table, the last attempt, the error of a failing one.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { syncRedirectsInTx } from "../deploy/redirect-sync.js";
import { json } from "./quality/_shared.js";

const unservedTarget = z.object({ fromPath: z.string(), location: z.string() });

const syncStatus = z.enum(["applied", "unchanged", "not-served", "nothing-live", "failed"]);

const outcomeSchema = z.object({
  targetId: z.string(),
  targetName: z.string(),
  env: z.enum(["staging", "production"]),
  status: syncStatus,
  revision: z.number().int(),
  redirectCount: z.number().int().nullable(),
  unservedTargets: z.array(unservedTarget),
  location: z.string().nullable(),
  error: z.string().nullable(),
});

export const syncRedirectsProviderOp = defineOperation({
  name: "redirects.sync_provider",
  // Why human-only: it decides nothing — it pushes the table the redirect
  // writes already saved. Every AI redirect write runs it after its commit
  // (and reports the outcome in the tool result), the worker retries a
  // failure, and the operator's "Try again" is the manual path; an AI tool
  // would only duplicate the automatic retry.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      trigger: z.enum(["save", "retry", "manual"]).default("manual"),
      /** Only these deploy targets (the retry worker passes the ones that are due). */
      targetIds: z.array(z.string().uuid()).max(100).optional(),
    })
    .strict(),
  output: z.object({ targets: z.array(outcomeSchema) }),
  handler: async (ctx, input, tx) => {
    const targets = await syncRedirectsInTx(tx, ctx, {
      trigger: input.trigger,
      ...(input.targetIds ? { targetIds: input.targetIds } : {}),
    });
    return ok({ targets: targets.map((t) => ({ ...t, unservedTargets: [...t.unservedTargets] })) });
  },
});

const targetStatusSchema = z.object({
  targetId: z.string(),
  targetName: z.string(),
  env: z.enum(["staging", "production"]),
  /** True when the provider serves the redirects table as saved. */
  inSync: z.boolean(),
  failedAttempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  last: z
    .object({
      status: syncStatus,
      trigger: z.string(),
      finishedAt: z.string(),
      redirectCount: z.number().int().nullable(),
      unservedTargets: z.array(unservedTarget),
      location: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});

/** One target's status, as {@link redirectSyncStatusOp} returns it. */
export type RedirectSyncTargetStatus = z.infer<typeof targetStatusSchema>;

export const redirectSyncStatusOp = defineOperation({
  name: "redirects.sync_status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ targets: z.array(targetStatusSchema) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT t.id::text AS id, t.name, t.env,
             COALESCE(s.wanted_revision, 0) AS wanted, COALESCE(s.synced_revision, 0) AS synced,
             COALESCE(s.failed_attempts, 0) AS failed_attempts,
             s.next_attempt_at, s.last_error,
             l.status AS last_status, l.trigger AS last_trigger, l.finished_at AS last_finished_at,
             l.redirect_count AS last_redirect_count, l.unserved_targets AS last_unserved,
             l.location AS last_location, l.error_message AS last_error_message
      FROM deploy_targets t
      LEFT JOIN redirect_sync_state s ON s.target_id = t.id
      LEFT JOIN LATERAL (
        SELECT * FROM redirect_syncs r WHERE r.target_id = t.id
        ORDER BY r.finished_at DESC, r.id DESC LIMIT 1
      ) l ON true
      WHERE t.env IN ('staging', 'production')
      ORDER BY (t.env = 'production') DESC, t.name
    `)) as unknown as {
      id: string;
      name: string;
      env: "staging" | "production";
      wanted: number | string;
      synced: number | string;
      failed_attempts: number;
      next_attempt_at: Date | string | null;
      last_error: string | null;
      last_status: z.infer<typeof syncStatus> | null;
      last_trigger: string | null;
      last_finished_at: Date | string | null;
      last_redirect_count: number | null;
      last_unserved: unknown;
      last_location: string | null;
      last_error_message: string | null;
    }[];
    const iso = (v: Date | string | null): string | null =>
      v === null ? null : v instanceof Date ? v.toISOString() : String(v);
    return ok({
      targets: rows.map((r) => ({
        targetId: r.id,
        targetName: r.name,
        env: r.env,
        inSync: Number(r.wanted) <= Number(r.synced),
        failedAttempts: r.failed_attempts,
        nextAttemptAt: iso(r.next_attempt_at),
        lastError: r.last_error,
        last:
          r.last_status === null
            ? null
            : {
                status: r.last_status,
                trigger: r.last_trigger ?? "",
                finishedAt: iso(r.last_finished_at) ?? "",
                redirectCount: r.last_redirect_count,
                unservedTargets: z.array(unservedTarget).parse(json(r.last_unserved)),
                location: r.last_location,
                error: r.last_error_message,
              },
      })),
    });
  },
});
