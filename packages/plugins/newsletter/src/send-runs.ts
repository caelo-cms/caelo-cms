// SPDX-License-Identifier: MPL-2.0

/**
 * Approved sends of the newsletter (#635).
 *
 * Campaigns, subscribers and the `sends` log live in cms_public, which a
 * compromised public side can rewrite. An email that went out cannot be
 * recalled and comes from the site's domain, so nothing public decides
 * what is sent or to whom:
 *
 *   - `send_campaign` is approval-gated, and its arguments ARE the
 *     approval: the subject, the body and the recipient bound the operator
 *     saw on the card. The operation snapshots exactly that, plus the
 *     recipient list as of the approval, into one `send_runs` row in the
 *     plugin's private storage (cms_admin). That single insert is the only
 *     write, so an approval either fully exists or does not.
 *   - The worker sends only from `send_runs`: one row per approval, sent
 *     once, in order, to the snapshot's addresses, deduplicated. It claims
 *     each batch by advancing the run's cursor (`send_progress`, one small
 *     row per run, keyed by the run's id) with a compare-and-swap BEFORE
 *     mailing it, so two workers (or a crash and a retry) never mail an
 *     address twice; a crash mid-batch leaves those addresses unsent, never
 *     duplicated. The cursor lives apart from the run because every
 *     private-storage write snapshots the whole row: advancing it on the
 *     run would copy the body and the recipient list on every tick.
 *   - Two approvals of one campaign (a double click, two chats) produce two
 *     runs; only the oldest sends, the other is marked `superseded`.
 *   - The public side can only suppress: a recipient whose subscriber row
 *     is gone or unsubscribed is skipped. `sends` rows are an outcome log
 *     the worker writes; a `pending` row there is not a queue entry and is
 *     marked failed (forged, or left over from before #635).
 */

import { type PluginContextTier1, type PluginQuery, z } from "@caelo-cms/plugin-sdk";

/** Most emails one worker tick sends, across all runs. */
export const SENDS_PER_TICK = 10;

/** Most stray `pending` rows of the public `sends` log one tick marks failed. */
const STRAY_SENDS_PER_TICK = 100;

/** A recipient the worker may mail: one plain address, no header tricks. */
const RECIPIENT = z.string().max(254).email();

/** One address of an approved run, as snapshotted at approval. */
const runRecipient = z
  .object({
    subscriberId: z.string().uuid(),
    email: RECIPIENT,
    unsubToken: z.string().min(1).max(200),
  })
  .strict();

type RunRecipient = z.infer<typeof runRecipient>;

/** A `send_runs` row as the worker reads it. */
const sendRun = z.object({
  id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  subject: z.string().min(1),
  body_html: z.string().min(1),
  recipients: z.array(runRecipient),
  status: z.enum(["approved", "done", "superseded"]),
});

type SendRun = z.infer<typeof sendRun>;

/** The `send_runs` table of the plugin's private storage. */
export const SEND_RUNS_TABLE = {
  campaign_id: "string",
  subject: "string",
  body_html: "text",
  recipients: "jsonb",
  recipient_count: "int",
  status: "enum:approved,done,superseded",
  approved_by: "string",
  created_at: "timestamp",
} as const;

/**
 * The `send_progress` table: how many of a run's recipients are claimed.
 * Its `id` is the run's id, so a run has at most one progress row even
 * when two workers create it at once.
 */
export const SEND_PROGRESS_TABLE = {
  id: "uuid",
  cursor: "int",
  created_at: "timestamp",
} as const;

/** The plugin's private storage, or a loud error before anything is read or written. */
export function adminQueryOf(ctx: PluginContextTier1): PluginQuery {
  const q = ctx.adminQuery;
  if (!q) {
    throw new Error(
      "newsletter: ctx.adminQuery missing — the cms_admin_schema capability was not granted, so no send can be approved or delivered",
    );
  }
  return q;
}

/**
 * The subscribers a send reaches: confirmed, not unsubscribed, with a
 * mailable address; one entry per address (case-insensitive), so a
 * duplicated subscriber row cannot double a recipient.
 */
export function eligibleRecipients(
  subscribers: ReadonlyArray<{
    id: string;
    email: string;
    unsub_token: string;
    confirmed_at: string | null;
    unsubscribed_at: string | null;
  }>,
): { recipients: RunRecipient[]; invalid: number } {
  const seen = new Set<string>();
  const recipients: RunRecipient[] = [];
  let invalid = 0;
  for (const s of subscribers) {
    if (!s.confirmed_at || s.unsubscribed_at) continue;
    const parsed = runRecipient.safeParse({
      subscriberId: s.id,
      email: s.email,
      unsubToken: s.unsub_token,
    });
    if (!parsed.success) {
      invalid += 1;
      continue;
    }
    const key = parsed.data.email.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(parsed.data);
  }
  return { recipients, invalid };
}

function unsubscribeFooter(unsubToken: string): string {
  return `<hr/><p style="font-size:12px"><a href="/api/plugin/newsletter/unsubscribe?token=${encodeURIComponent(unsubToken)}">Unsubscribe</a></p>`;
}

/** Mark stray `pending` rows of the public `sends` log failed: never a queue. */
async function quarantineStraySends(ctx: PluginContextTier1): Promise<number> {
  const stray = await ctx.query.list<"sends", { id: string }>("sends", {
    status: "pending",
    orderBy: "created_at",
    orderDir: "asc",
    limit: STRAY_SENDS_PER_TICK,
  });
  for (const row of stray) {
    await ctx.query.update("sends", row.id, {
      status: "failed",
      error: "not part of an approved send run — never sent",
    });
  }
  return stray.length;
}

/** Whether `run` is the oldest run of its campaign — the one that sends. */
async function isFirstRunOfCampaign(admin: PluginQuery, run: SendRun): Promise<boolean> {
  const runs = await admin.list<"send_runs", { id: string }>("send_runs", {
    campaign_id: run.campaign_id,
    orderBy: "created_at",
    orderDir: "asc",
    limit: 1,
  });
  return runs[0]?.id === run.id;
}

/** The run's progress row, created on first use (a lost race re-reads it). */
async function progressOf(admin: PluginQuery, runId: string): Promise<number> {
  const read = async () =>
    (
      await admin.list<"send_progress", { cursor: number }>("send_progress", {
        id: runId,
        limit: 1,
      })
    )[0];
  const existing = await read();
  if (existing) return existing.cursor;
  try {
    await admin.insert("send_progress", { id: runId, cursor: 0 });
  } catch (e) {
    const raced = await read();
    if (raced) return raced.cursor;
    throw e;
  }
  return 0;
}

/** Mark a fully claimed run done and its public campaign sent. */
async function finishRun(ctx: PluginContextTier1, admin: PluginQuery, run: SendRun): Promise<void> {
  await admin.compareAndSwap("send_runs", run.id, { status: "approved" }, { status: "done" });
  await ctx.query.update("campaigns", run.campaign_id, {
    status: "sent",
    sent_at: new Date().toISOString(),
  });
}

/** Whether the public side still lists the recipient as subscribed. */
async function stillSubscribed(ctx: PluginContextTier1, r: RunRecipient): Promise<boolean> {
  const rows = await ctx.query.list<"subscribers", { unsubscribed_at: string | null }>(
    "subscribers",
    { id: r.subscriberId, limit: 1 },
  );
  return rows[0] !== undefined && !rows[0].unsubscribed_at;
}

async function logSend(
  ctx: PluginContextTier1,
  run: SendRun,
  r: RunRecipient,
  outcome: { status: "sent" } | { status: "failed"; error: string },
): Promise<void> {
  await ctx.query.insert("sends", {
    run_id: run.id,
    campaign_id: run.campaign_id,
    subscriber_id: r.subscriberId,
    status: outcome.status,
    ...(outcome.status === "sent"
      ? { sent_at: new Date().toISOString() }
      : { error: outcome.error }),
  });
}

/** Mail one claimed recipient; true when it went out. */
async function deliver(ctx: PluginContextTier1, run: SendRun, r: RunRecipient): Promise<boolean> {
  if (!(await stillSubscribed(ctx, r))) {
    await logSend(ctx, run, r, { status: "failed", error: "unsubscribed before the send" });
    return false;
  }
  try {
    if (!ctx.email) throw new Error("no email transport configured");
    await ctx.email.send({
      to: r.email,
      subject: run.subject,
      html: `${run.body_html}${unsubscribeFooter(r.unsubToken)}`,
    });
  } catch (e) {
    await logSend(ctx, run, r, { status: "failed", error: (e as Error).message });
    return false;
  }
  await logSend(ctx, run, r, { status: "sent" });
  return true;
}

/**
 * Worker tick: send up to {@link SENDS_PER_TICK} emails from approved runs,
 * oldest first, and mark stray public queue rows failed.
 */
export async function drainSends(
  ctx: PluginContextTier1,
): Promise<{ sent: number; attempted: number; superseded: number; quarantined: number }> {
  const admin = adminQueryOf(ctx);
  const quarantined = await quarantineStraySends(ctx);
  const rows = await admin.list("send_runs", {
    status: "approved",
    orderBy: "created_at",
    orderDir: "asc",
    limit: 10,
  });
  let budget = SENDS_PER_TICK;
  let sent = 0;
  let attempted = 0;
  let superseded = 0;
  for (const row of rows) {
    if (budget === 0) break;
    // Our own private storage, but parsed all the same: a malformed run
    // must stop loudly rather than mail something half-understood.
    const run = sendRun.parse(row);
    if (!(await isFirstRunOfCampaign(admin, run))) {
      const swapped = await admin.compareAndSwap(
        "send_runs",
        run.id,
        { status: "approved" },
        { status: "superseded" },
      );
      if (swapped) superseded += 1;
      continue;
    }
    const cursor = await progressOf(admin, run.id);
    const batch = run.recipients.slice(cursor, cursor + budget);
    const next = cursor + batch.length;
    if (batch.length > 0) {
      // The public status is display only, but written before the claim:
      // if it fails, the tick fails loudly with nothing claimed or lost.
      if (cursor === 0) {
        await ctx.query.update("campaigns", run.campaign_id, { status: "sending" });
      }
      // Claim before mailing: whoever advances the cursor owns the batch.
      const claimed = await admin.compareAndSwap(
        "send_progress",
        run.id,
        { cursor },
        { cursor: next },
      );
      if (!claimed) continue;
      for (const r of batch) {
        budget -= 1;
        attempted += 1;
        if (await deliver(ctx, run, r)) sent += 1;
      }
    }
    // Also reached by a tick after a crash between the last claim and here.
    if (next >= run.recipients.length) await finishRun(ctx, admin, run);
  }
  return { sent, attempted, superseded, quarantined };
}
