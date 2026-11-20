// SPDX-License-Identifier: MPL-2.0

/**
 * The WebSub pings and IndexNow submissions of production runs
 * (docs/dev/search-engine-feed.md):
 *
 *   - search_notify.claim  — take the due ones to send (system).
 *   - search_notify.record — what the engine answered (system).
 *
 * Only the sender (search-feed/notify.ts) claims and records: right after
 * a Publish live, inside its request, and on the scheduler tick. Settings
 * → SEO and the AI read the latest through `site_defaults.get_seo`.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { announcedUrls } from "../search-feed/notifications.js";

/** Sends of one notification before it is given up as failed. */
export const SEARCH_NOTIFY_MAX_ATTEMPTS = 6;

/** How long a claimed notification is held for its sender before it is due again. */
const CLAIM_HOLD_SECONDS = 600;

const channel = z.enum(["websub", "indexnow"]);

/** One claimed notification, with what its request needs. */
const claimedShape = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  channel,
  attempts: z.number().int(),
  feedUrl: z.string().nullable(),
  indexNowKey: z.string().nullable(),
  /** IndexNow: every URL to submit. */
  urls: z.array(z.string()),
});
export type ClaimedSearchNotification = z.infer<typeof claimedShape>;

export const claimSearchNotificationsOp = defineOperation({
  name: "search_notify.claim",
  readScope: "request",
  // Why system-only: only the admin's sender claims notifications to send.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      /** Only this run's (right after its Publish live); omitted: every due one. */
      runId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(20),
    })
    .strict(),
  output: z.object({ claimed: z.array(claimedShape) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT n.id::text AS id, n.run_id::text AS run_id, n.channel, n.attempts,
             r.feed_url, r.indexnow_key
      FROM search_engine_notifications n
      JOIN deploy_runs r ON r.id = n.run_id
      WHERE n.status = 'pending' AND n.next_attempt_at <= clock_timestamp()
        ${input.runId ? sql`AND n.run_id = ${input.runId}::uuid` : sql``}
      ORDER BY n.next_attempt_at
      LIMIT ${input.limit}
      FOR UPDATE OF n SKIP LOCKED
    `)) as unknown as {
      id: string;
      run_id: string;
      channel: "websub" | "indexnow";
      attempts: number;
      feed_url: string | null;
      indexnow_key: string | null;
    }[];
    const claimed: ClaimedSearchNotification[] = [];
    for (const r of rows) {
      await tx.execute(sql`
        UPDATE search_engine_notifications
        SET attempts = attempts + 1,
            next_attempt_at = clock_timestamp() + make_interval(secs => ${CLAIM_HOLD_SECONDS})
        WHERE id = ${r.id}::uuid
      `);
      claimed.push({
        id: r.id,
        runId: r.run_id,
        channel: r.channel,
        attempts: r.attempts + 1,
        feedUrl: r.feed_url,
        indexNowKey: r.indexnow_key,
        urls: r.channel === "indexnow" ? await announcedUrls(tx, r.run_id) : [],
      });
    }
    return ok({ claimed });
  },
});

export const recordSearchNotificationOp = defineOperation({
  name: "search_notify.record",
  readScope: "request",
  // Why system-only: the outcome of a request the admin's sender made.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      id: z.string().uuid(),
      /** `retry` becomes `failed` once the attempts are used up. */
      outcome: z.enum(["sent", "retry", "failed"]),
      responseStatus: z.number().int().nullable(),
      detail: z.string().max(2000).nullable(),
      /** For `retry`: wait at least this long (the engine's Retry-After). */
      retryAfterSeconds: z.number().int().min(0).max(86_400).nullable(),
    })
    .strict(),
  output: z.object({ status: z.enum(["sent", "pending", "failed"]) }),
  handler: async (ctx, input, tx) => {
    const row = (
      (await tx.execute(sql`
        SELECT attempts, channel, url_count FROM search_engine_notifications
        WHERE id = ${input.id}::uuid FOR UPDATE
      `)) as unknown as { attempts: number; channel: string; url_count: number }[]
    )[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "search_notify.record",
        message: `search notification ${input.id} not found`,
      });
    }
    const giveUp = input.outcome === "retry" && row.attempts >= SEARCH_NOTIFY_MAX_ATTEMPTS;
    // What the site told a third party, and how it answered.
    const audit = (status: string) =>
      recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "search_notify.record",
        input,
        succeeded: true,
        entityId: input.id,
        resultSummary: `${row.channel} ${status} (attempt ${row.attempts}, ${row.url_count} URL(s), HTTP ${input.responseStatus ?? "none"})`,
      });
    if (input.outcome === "retry" && !giveUp) {
      // 2, 4, 8 … minutes, at least what the engine asked for.
      const backoff = Math.max(2 ** row.attempts * 60, input.retryAfterSeconds ?? 0);
      await tx.execute(sql`
        UPDATE search_engine_notifications
        SET next_attempt_at = clock_timestamp() + make_interval(secs => ${backoff}),
            response_status = ${input.responseStatus}, detail = ${input.detail}
        WHERE id = ${input.id}::uuid
      `);
      await audit("retry");
      return ok({ status: "pending" as const });
    }
    const status = input.outcome === "sent" ? "sent" : "failed";
    const detail = giveUp
      ? `given up after ${row.attempts} attempts: ${input.detail ?? "no answer"}`.slice(0, 2000)
      : input.detail;
    await tx.execute(sql`
      UPDATE search_engine_notifications
      SET status = ${status}, next_attempt_at = NULL, finished_at = clock_timestamp(),
          response_status = ${input.responseStatus}, detail = ${detail}
      WHERE id = ${input.id}::uuid
    `);
    await audit(status);
    return ok({ status });
  },
});

/** One notification as Settings → SEO and the AI read it. */
export const searchNotificationShape = z.object({
  id: z.string(),
  runId: z.string(),
  channel,
  status: z.enum(["pending", "sent", "failed", "skipped"]),
  urlCount: z.number().int(),
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  detail: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type SearchNotification = z.infer<typeof searchNotificationShape>;

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** The latest notifications, newest first. */
export async function recentSearchNotifications(
  tx: Tx,
  limit: number,
): Promise<SearchNotification[]> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, run_id::text AS run_id, channel, status, url_count, attempts,
           response_status, detail, created_at, finished_at
    FROM search_engine_notifications
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)) as unknown as {
    id: string;
    run_id: string;
    channel: "websub" | "indexnow";
    status: SearchNotification["status"];
    url_count: number;
    attempts: number;
    response_status: number | null;
    detail: string | null;
    created_at: string | Date;
    finished_at: string | Date | null;
  }[];
  const iso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    channel: r.channel,
    status: r.status,
    urlCount: r.url_count,
    attempts: r.attempts,
    responseStatus: r.response_status,
    detail: r.detail,
    createdAt: iso(r.created_at),
    finishedAt: r.finished_at === null ? null : iso(r.finished_at),
  }));
}
