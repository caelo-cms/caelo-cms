// SPDX-License-Identifier: MPL-2.0

/**
 * Automatic Caelo updates — the scheduler's ops (epic #696 Phase 5).
 *
 *   platform_updates.scheduler_tick        one decision: lease, policy, soak,
 *                                          window, pause → queue an automatic
 *                                          request + the Owner's emails
 *   platform_updates.notification_claim    take undelivered emails to send
 *   platform_updates.notification_finish   record how sending went
 *   platform_updates.scheduler_status      the last decision + recent emails
 *                                          (Settings → Updates, the AI)
 *
 * The scheduler (platform-updates/scheduler.ts) runs inside every admin
 * instance (CLAUDE.md §11.B Tier 5). What keeps N instances from doing N
 * things:
 *   - the tick's lease: `platform_update_scheduler.last_run_at` is moved
 *     forward by one UPDATE whose WHERE requires the previous tick to be an
 *     interval old — concurrent ticks serialize on the row and all but one
 *     find nothing to update;
 *   - `platform_update_requests_one_active` (one request in flight) and
 *     `platform_update_requests_one_auto_per_version` (one automatic attempt
 *     per release, ever): even two ticks that both decided "install" insert
 *     one row;
 *   - `platform_update_notifications.dedupe_key` (one email per event) and
 *     the claim's `FOR UPDATE SKIP LOCKED` (one sender per email).
 *
 * An automatic request is the same row a manual install writes —
 * `trigger = 'auto'`, no requester, `auto_basis` naming why — so whatever
 * picks up requests (the GCP upgrader job, the self-hosted agent) picks it
 * up the same way, and re-checks it against the signed manifest.
 *
 * All writes here are system-only: the AI only informs (#696 decision 3),
 * and an Owner changes behaviour through the policy ops, never these.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import {
  AUTO_UPDATE_ACTIONS,
  type AutoUpdateDecision,
  CAELO_VERSION,
  decideAutoUpdate,
  err,
  isNewerVersion,
  ok,
  PLATFORM_UPDATE_ROUTES,
  type PlatformUpdateRoute,
  UPDATE_NOTIFICATION_KINDS,
  type UpdateNotificationKind,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditFromCtx } from "../audit.js";
import { updateNotificationText } from "../platform-updates/notification-text.js";
import { readUpdatePolicy } from "./platform-update-policy.js";
import { endStaleRuns } from "./platform-update-requests.js";

const handlerError = (operation: string, message: string) =>
  err({ kind: "HandlerError" as const, operation, message });

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

/** A pending automatic request this long without the upgrader claiming it is started again. */
export const AUTO_REQUEST_RESTART_MINUTES = 10;

/** A notification claimed this long ago without a result is claimed again. */
const SENDING_STALE_MINUTES = 10;

const releaseFactsSchema = z
  .object({
    security: z.boolean(),
    advisories: z.array(z.string().max(64)).max(50),
    contractMigrations: z.boolean(),
    infraChange: z.boolean().nullable(),
  })
  .strict();

const MISSING_SCHEDULER_ROW =
  "platform_update_scheduler has no row (id = 1); migration 0271 seeds it — re-run the database migrations.";

const SCHEDULER_TICK = "platform_updates.scheduler_tick";

/** Insert one outbox row unless its dedupe key exists; returns whether it was new. */
async function enqueueNotification(
  tx: TransactionRunner,
  n: {
    readonly kind: UpdateNotificationKind;
    readonly dedupeKey: string;
    readonly version: string;
    readonly installedVersion: string;
    readonly reason: string | null;
    readonly requestId?: string;
    readonly at?: Date | null;
  },
): Promise<boolean> {
  const text = updateNotificationText({
    kind: n.kind,
    version: n.version,
    installedVersion: n.installedVersion,
    reason: n.reason,
    at: n.at ?? null,
  });
  const rows = (await tx.execute(sql`
    INSERT INTO platform_update_notifications
      (kind, target_version, request_id, dedupe_key, subject, body)
    VALUES (${n.kind}, ${n.version}, ${n.requestId ?? null}::uuid, ${n.dedupeKey},
            ${text.subject.slice(0, 300)}, ${text.body.slice(0, 8000)})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length > 0;
}

/** The notification a decision about the newest release warrants, if any. */
function notificationForDecision(
  d: AutoUpdateDecision,
): { kind: UpdateNotificationKind; at?: Date | null } | null {
  switch (d.action) {
    case "none":
      return null;
    case "needs_cloud_shell":
      return { kind: "needs_cloud_shell" };
    case "install":
      return { kind: "scheduled", at: null };
    case "wait":
      return d.paused ? { kind: "available" } : { kind: "scheduled", at: d.until };
    default:
      return { kind: "available" };
  }
}

export const platformUpdatesSchedulerTickOp = defineOperation({
  name: "platform_updates.scheduler_tick",
  // Why system-only: the admin's own background scheduler (#696 Phase 5).
  // It can only queue "the newest release, as the Owner's policy allows";
  // the AI only informs (#696 decision 3).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      /** Which admin instance runs the tick (for the status line). */
      holder: z.string().min(1).max(200),
      /** The tick runs only when the previous one is at least this old. */
      intervalSeconds: z.number().int().min(30).max(86_400),
      /** The release the facts describe (the cache may move on mid-tick). */
      factsVersion: z.string().max(64).nullable(),
      facts: z.union([releaseFactsSchema, z.object({ unavailable: z.string().min(1).max(1000) })]),
      /** This install has an upgrader the admin can hand a request to. */
      upgraderAvailable: z.boolean(),
      /** This install has a converge job the admin can start (#819). */
      convergeAvailable: z.boolean(),
      /** Why it has none right now (e.g. the self-hosted agent is not checking in). */
      upgraderProblem: z.string().max(2000).nullable(),
    })
    .strict(),
  output: z.object({
    ran: z.boolean(),
    action: z.enum(AUTO_UPDATE_ACTIONS).nullable(),
    reason: z.string().nullable(),
    /** A new automatic request to start the upgrader for. */
    requestId: z.string().nullable(),
    /** A pending automatic request the upgrader never claimed: start it again. */
    restartRequestId: z.string().nullable(),
    /**
     * Which job the request to start (new or restarted) is for (#819): the
     * upgrader, or the converge job when the Owner allowed cloud-setup
     * releases to install automatically. Null when there is none.
     */
    startRoute: z.enum(PLATFORM_UPDATE_ROUTES).nullable(),
    /** New outbox rows this tick wrote. */
    notificationsQueued: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    // 1. The lease. Concurrent ticks block on the row and then find it fresh.
    // A few seconds of slack so a timer firing slightly early still runs.
    const leased = (await tx.execute(sql`
      UPDATE platform_update_scheduler
         SET lease_holder = ${input.holder}, last_run_at = now()
       WHERE id = 1
         AND (last_run_at IS NULL
              OR last_run_at <= now() - make_interval(secs => ${Math.max(0, input.intervalSeconds - 5)}))
       RETURNING id
    `)) as unknown as { id: number }[];
    if (leased.length === 0) {
      const exists = (await tx.execute(sql`
        SELECT 1 AS one FROM platform_update_scheduler WHERE id = 1
      `)) as unknown as { one: number }[];
      if (exists.length === 0) return handlerError(SCHEDULER_TICK, MISSING_SCHEDULER_ROW);
      return ok({
        ran: false,
        action: null,
        reason: null,
        requestId: null,
        restartRequestId: null,
        startRoute: null,
        notificationsQueued: 0,
      });
    }

    // 2. A dead run must not block automatic installs forever (on Google
    // Cloud nothing else starts the upgrader job while nobody clicks).
    await endStaleRuns(tx);

    // An Owner pause whose end has passed is over.
    const lifted = (await tx.execute(sql`
      UPDATE platform_update_policy
         SET paused = false, paused_at = NULL, paused_reason = NULL, paused_until = NULL,
             paused_by = NULL, updated_at = now()
       WHERE id = 1 AND paused AND paused_until IS NOT NULL AND paused_until <= now()
       RETURNING id
    `)) as unknown as { id: number }[];
    if (lifted.length > 0) {
      await recordAuditFromCtx(tx, ctx, {
        operation: SCHEDULER_TICK,
        input: { event: "pause-ended" },
        succeeded: true,
        resultSummary: "the Owner's pause of automatic updates ended",
      });
    }

    const policy = await readUpdatePolicy(tx);
    if (!policy) {
      return handlerError(
        SCHEDULER_TICK,
        "platform_update_policy has no row (id = 1); migration 0267 seeds it — re-run the database migrations.",
      );
    }
    const cache = (
      (await tx.execute(sql`
        SELECT latest_version, published_at FROM release_check_cache WHERE id = 1
      `)) as unknown as { latest_version: string | null; published_at: Date | string | null }[]
    )[0];
    if (!cache) {
      return handlerError(
        SCHEDULER_TICK,
        "release_check_cache has no row (id = 1); migration 0053 seeds it — re-run the database migrations.",
      );
    }
    const release =
      cache.latest_version === null
        ? null
        : { version: cache.latest_version, publishedAt: iso(cache.published_at) };
    // The release check moved on between reading the facts and this tick:
    // decide nothing now (the next tick reads the new release's facts).
    const raced =
      release !== null &&
      isNewerVersion(release.version, CAELO_VERSION) &&
      input.factsVersion !== release.version;
    const facts = raced
      ? { unavailable: "the newest release changed while it was being checked" }
      : input.facts;

    let decision = decideAutoUpdate({
      policy,
      installedVersion: CAELO_VERSION,
      release,
      facts,
      upgraderAvailable: input.upgraderAvailable,
      upgraderProblem: input.upgraderProblem,
      convergeAvailable: input.convergeAvailable,
      now: new Date(),
    });

    // 3. One automatic attempt per release: a failed, refused or cancelled
    // one is not retried on its own, and a running one is not doubled. Its
    // own emails (below) say how it went; no second "available" mail.
    let alreadyTried = false;
    if (decision.action === "install" || decision.action === "wait") {
      const prior = (
        (await tx.execute(sql`
          SELECT status FROM platform_update_requests
           WHERE trigger = 'auto' AND target_version = ${decision.version}
        `)) as unknown as { status: string }[]
      )[0];
      if (prior) {
        alreadyTried = true;
        decision =
          prior.status === "pending" || prior.status === "running"
            ? {
                ...decision,
                action: "wait",
                until: null,
                paused: false,
                reason: `The automatic install of v${decision.version} is under way.`,
              }
            : {
                action: "notify",
                version: decision.version,
                kind: decision.kind,
                reason: `The automatic install of v${decision.version} was already tried (${prior.status.replace("_", " ")}); it is not retried automatically. Install it from Settings → Updates.`,
              };
      }
    }

    // 4. Queue the install.
    let requestId: string | null = null;
    if (decision.action === "install") {
      const active = (await tx.execute(sql`
        SELECT target_version FROM platform_update_requests
         WHERE status IN ('pending', 'running') LIMIT 1
      `)) as unknown as { target_version: string }[];
      if (active[0]) {
        decision = {
          ...decision,
          action: "wait",
          until: null,
          paused: false,
          reason: `v${decision.version} installs automatically once the update to v${active[0].target_version} in progress has finished.`,
        };
      } else {
        const inserted = (await tx.execute(sql`
          INSERT INTO platform_update_requests
            (target_version, from_version, trigger, auto_basis, route)
          VALUES (${decision.version}, ${CAELO_VERSION}, 'auto', ${decision.basis}, ${decision.route})
          ON CONFLICT DO NOTHING
          RETURNING id::text AS id
        `)) as unknown as { id: string }[];
        requestId = inserted[0]?.id ?? null;
        if (requestId) {
          await tx.execute(sql`
            INSERT INTO platform_update_events (request_id, phase, level, message)
            VALUES (${requestId}::uuid, 'queued', 'info',
                    ${`Automatic install queued by the update policy. ${decision.reason}`.slice(0, 4000)})
          `);
          await recordAuditFromCtx(tx, ctx, {
            operation: SCHEDULER_TICK,
            input: {
              event: "queued",
              targetVersion: decision.version,
              basis: decision.basis,
              route: decision.route,
            },
            succeeded: true,
            entityId: requestId,
            resultSummary: `queued automatic ${CAELO_VERSION} → ${decision.version} (${decision.basis})`,
          });
        }
      }
    }

    // 5. Emails about the newest release.
    let queued = 0;
    const forDecision = notificationForDecision(decision);
    if (forDecision && decision.action !== "none" && !alreadyTried && !raced) {
      const added = await enqueueNotification(tx, {
        kind: forDecision.kind,
        dedupeKey: `${forDecision.kind}:${decision.version}`,
        version: decision.version,
        installedVersion: CAELO_VERSION,
        reason: decision.reason,
        at: forDecision.at ?? null,
        ...(requestId ? { requestId } : {}),
      });
      if (added) queued += 1;
    }

    // 6. Emails about how automatic installs ended (the job writes the end).
    const ended = (await tx.execute(sql`
      SELECT id::text AS id, target_version, from_version, status, status_reason
        FROM platform_update_requests
       WHERE trigger = 'auto'
         AND status IN ('succeeded', 'rolled_back', 'failed', 'refused', 'needs_cloud_shell')
         AND finished_at > now() - interval '7 days'
    `)) as unknown as {
      id: string;
      target_version: string;
      from_version: string;
      status: "succeeded" | "rolled_back" | "failed" | "refused" | "needs_cloud_shell";
      status_reason: string | null;
    }[];
    for (const r of ended) {
      const kind: UpdateNotificationKind =
        r.status === "succeeded"
          ? "installed"
          : r.status === "needs_cloud_shell"
            ? "needs_cloud_shell"
            : "failed";
      const paused = r.status === "rolled_back" || r.status === "failed";
      const reason = [
        r.status_reason,
        paused ? "Automatic updates are paused until you resume them at Settings → Updates." : null,
      ]
        .filter(Boolean)
        .join(" ");
      const added = await enqueueNotification(tx, {
        kind,
        // needs_cloud_shell is about the release, whoever found out first.
        dedupeKey: kind === "needs_cloud_shell" ? `${kind}:${r.target_version}` : `${kind}:${r.id}`,
        version: r.target_version,
        installedVersion: r.from_version,
        reason: reason.length > 0 ? reason : null,
        requestId: r.id,
      });
      if (added) queued += 1;
    }

    // 7. A request the upgrader never claimed (the start was lost).
    const stuck = (await tx.execute(sql`
      SELECT id::text AS id, route FROM platform_update_requests
       WHERE trigger = 'auto' AND status = 'pending'
         AND requested_at < now() - make_interval(mins => ${AUTO_REQUEST_RESTART_MINUTES})
       ORDER BY requested_at LIMIT 1
    `)) as unknown as { id: string; route: PlatformUpdateRoute }[];

    const waitUntil = decision.action === "wait" ? decision.until : null;
    await tx.execute(sql`
      UPDATE platform_update_scheduler
         SET last_version = ${decision.action === "none" ? null : decision.version},
             last_action = ${decision.action},
             last_reason = ${decision.reason.slice(0, 2000)},
             last_wait_until = ${waitUntil ? waitUntil.toISOString() : null}::timestamptz
       WHERE id = 1
    `);
    return ok({
      ran: true,
      action: decision.action,
      reason: decision.reason,
      requestId,
      restartRequestId: requestId ? null : (stuck[0]?.id ?? null),
      startRoute:
        requestId && decision.action === "install"
          ? decision.route
          : requestId
            ? null
            : (stuck[0]?.route ?? null),
      notificationsQueued: queued,
    });
  },
});

const claimedNotification = z.object({
  id: z.string(),
  kind: z.enum(UPDATE_NOTIFICATION_KINDS),
  subject: z.string(),
  body: z.string(),
});

export const platformUpdatesNotificationClaimOp = defineOperation({
  name: "platform_updates.notification_claim",
  // Why system-only: the scheduler's email delivery (#696 Phase 5).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.object({
    notifications: z.array(claimedNotification),
    /** Everyone holding platform.update (the Owners) with an email address. */
    recipients: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE platform_update_notifications
         SET delivery_status = 'sending', claimed_at = now()
       WHERE id IN (
         SELECT id FROM platform_update_notifications
          WHERE delivery_status = 'pending'
             OR (delivery_status = 'sending'
                 AND claimed_at < now() - make_interval(mins => ${SENDING_STALE_MINUTES}))
          ORDER BY created_at
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text AS id, kind, subject, body
    `)) as unknown as z.infer<typeof claimedNotification>[];
    if (rows.length === 0) return ok({ notifications: [], recipients: [] });
    const owners = (await tx.execute(sql`
      SELECT DISTINCT u.email
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
       WHERE p.name = 'platform.update' AND u.deleted_at IS NULL
       ORDER BY u.email
    `)) as unknown as { email: string }[];
    return ok({ notifications: rows, recipients: owners.map((o) => o.email) });
  },
});

export const platformUpdatesNotificationFinishOp = defineOperation({
  name: "platform_updates.notification_finish",
  // Why system-only: the scheduler records how its own delivery went.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      id: z.string().uuid(),
      status: z.enum(["sent", "failed", "no_transport", "no_recipients"]),
      detail: z.string().max(2000).nullable(),
      recipients: z.array(z.string().max(320)).max(50),
    })
    .strict(),
  output: z.object({ recorded: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const recipients =
      input.recipients.length > 0
        ? sql`ARRAY[${sql.join(
            input.recipients.map((r) => sql`${r}`),
            sql`, `,
          )}]::text[]`
        : sql`'{}'::text[]`;
    const rows = (await tx.execute(sql`
      UPDATE platform_update_notifications
         SET delivery_status = ${input.status}, delivery_detail = ${input.detail},
             recipients = ${recipients}, delivered_at = now()
       WHERE id = ${input.id}::uuid AND delivery_status = 'sending'
       RETURNING id
    `)) as unknown as { id: string }[];
    await recordAuditFromCtx(tx, ctx, {
      operation: "platform_updates.notification_finish",
      input: { id: input.id, status: input.status },
      succeeded: input.status === "sent",
      entityId: input.id,
      resultSummary: `${input.status}${input.detail ? `: ${input.detail}` : ""}`.slice(0, 200),
    });
    return ok({ recorded: rows.length > 0 });
  },
});

export const updateNotificationSchema = z.object({
  id: z.string(),
  kind: z.enum(UPDATE_NOTIFICATION_KINDS),
  targetVersion: z.string(),
  subject: z.string(),
  createdAt: z.string(),
  deliveryStatus: z.enum(["pending", "sending", "sent", "failed", "no_transport", "no_recipients"]),
  deliveryDetail: z.string().nullable(),
});
/** One of the Owner's update emails as the page and the AI see it. */
export type UpdateNotification = z.infer<typeof updateNotificationSchema>;

const schedulerStatusSchema = z.object({
  /** When a tick last ran; null = the scheduler never ran on this install. */
  lastRunAt: z.string().nullable(),
  lastVersion: z.string().nullable(),
  lastAction: z.enum(AUTO_UPDATE_ACTIONS).nullable(),
  lastReason: z.string().nullable(),
  /** When a waiting release becomes installable (soak over / window opens). */
  lastWaitUntil: z.string().nullable(),
  notifications: z.array(updateNotificationSchema),
});
/** Output of `platform_updates.scheduler_status`. */
export type SchedulerStatus = z.infer<typeof schedulerStatusSchema>;

export const platformUpdatesSchedulerStatusOp = defineOperation({
  name: "platform_updates.scheduler_status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
  output: schedulerStatusSchema,
  handler: async (_ctx, input, tx) => {
    const s = (
      (await tx.execute(sql`
        SELECT last_run_at, last_version, last_action, last_reason, last_wait_until
          FROM platform_update_scheduler WHERE id = 1
      `)) as unknown as {
        last_run_at: Date | string | null;
        last_version: string | null;
        last_action: SchedulerStatus["lastAction"];
        last_reason: string | null;
        last_wait_until: Date | string | null;
      }[]
    )[0];
    if (!s) return handlerError("platform_updates.scheduler_status", MISSING_SCHEDULER_ROW);
    const notes = (await tx.execute(sql`
      SELECT id::text AS id, kind, target_version, subject, created_at,
             delivery_status, delivery_detail
        FROM platform_update_notifications
       ORDER BY created_at DESC
       LIMIT ${input.limit ?? 10}
    `)) as unknown as {
      id: string;
      kind: UpdateNotification["kind"];
      target_version: string;
      subject: string;
      created_at: Date | string;
      delivery_status: UpdateNotification["deliveryStatus"];
      delivery_detail: string | null;
    }[];
    return ok({
      lastRunAt: iso(s.last_run_at),
      lastVersion: s.last_version,
      lastAction: s.last_action,
      lastReason: s.last_reason,
      lastWaitUntil: iso(s.last_wait_until),
      notifications: notes.map((n) => ({
        id: n.id,
        kind: n.kind,
        targetVersion: n.target_version,
        subject: n.subject,
        createdAt: iso(n.created_at) as string,
        deliveryStatus: n.delivery_status,
        deliveryDetail: n.delivery_detail,
      })),
    });
  },
});
