// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part B — the hard rule: a Stage the AI initiated NEVER reaches
 * production automatically.
 *
 * The AI may Stage (merge into main, build staging, run the quality check);
 * Publish live stays a human action behind the #553 gate. But once the AI
 * merged, main holds changes no human has published, and the automatic
 * paths that rebuild production from main — the auto-redeploy's direct
 * production build (#599) and the audit-gated automatic publish
 * (`quality_audits.settle_auto_publish`) — would ship them unseen.
 *
 * So every AI-initiated merge into main opens a HOLD in the same
 * transaction as the merge — also when it merged nothing: the AI still
 * triggered the staging build an automatic publish would promote. While a
 * hold is open, every SYSTEM-initiated production build or promote is
 * refused (`deploy.trigger` / `deploy.promote`).
 *
 * Serialization. The hold check and the generator's reads of main must not
 * interleave with an AI merge: a merge committing while an automatic
 * production build runs could land in that build after its check passed.
 * An advisory lock orders them — AI merges take it SHARED (they may run
 * side by side), an automatic production build or promote takes it
 * EXCLUSIVE for its whole transaction (check + generator run + publish).
 * A merge that cannot get its shared lock is refused with a "try again"
 * message instead of waiting for a build to finish; a production build
 * waits for in-flight AI merges, then sees their holds.
 *
 * Release is exact, never by time: every build records the open holds it
 * covers (`deploy_runs.covered_ai_hold_ids`, read as the build starts —
 * a hold visible then was committed with its merge, so the build contains
 * that merge). A human production publish releases exactly the holds its
 * build covers; a hold whose merge committed during the build stays open.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";

/**
 * The advisory-lock key that orders AI merges against automatic production
 * publishes. Exported for the serialization regression tests.
 */
export const AI_STAGE_LOCK_KEY = "caelo:ai-stage-hold";

const lockKey = (): SQL => sql`hashtext(${AI_STAGE_LOCK_KEY})`;

/** True when this merge is an AI Stage: the AI acting itself, or a tool running for it. */
export function isAiInitiated(ctx: ExecutionContext, aiInitiated: boolean | undefined): boolean {
  return ctx.actorKind === "ai" || aiInitiated === true;
}

/** The refusal an AI merge gets while an automatic production publish runs. */
export const AI_MERGE_BUSY_MESSAGE =
  "an automatic production publish is running right now, and an AI Stage must not land in it — nothing was staged; stage again in a minute";

/**
 * Take the AI-merge side of the lock (shared, this transaction). Returns
 * false when an automatic production publish holds it — the caller refuses
 * the merge with {@link AI_MERGE_BUSY_MESSAGE}.
 */
export async function enterAiMerge(tx: TransactionRunner): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT pg_try_advisory_xact_lock_shared(${lockKey()}) AS ok
  `)) as unknown as { ok: boolean }[];
  return rows[0]?.ok === true;
}

/**
 * Take the automatic-publish side of the lock (exclusive, this
 * transaction): waits for in-flight AI merges to commit, so the hold check
 * that follows sees their holds, and keeps new AI merges out until the
 * transaction (and the build it runs) ends.
 */
export async function lockForAutomaticProductionPublish(tx: TransactionRunner): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey()})`);
}

/**
 * Open a hold for an AI-initiated merge. The caller entered the merge with
 * {@link enterAiMerge} in the same transaction.
 */
export async function recordAiStageHold(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  chatSessionIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO ai_stage_holds (chat_session_ids, actor_id)
    VALUES (
      ${
        chatSessionIds.length === 0
          ? sql`'{}'::uuid[]`
          : sql`ARRAY[${sql.join(
              chatSessionIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`
      },
      ${ctx.actorId}::uuid
    )
  `);
}

/** The open holds, oldest first. */
async function openAiStageHolds(
  tx: TransactionRunner,
): Promise<{ id: string; chatTitles: string[] }[]> {
  const rows = (await tx.execute(sql`
    SELECT h.id::text AS id,
           COALESCE(
             (SELECT array_agg(cs.title ORDER BY cs.title) FROM chat_sessions cs
               WHERE cs.id = ANY(h.chat_session_ids)),
             '{}'
           ) AS chat_titles
    FROM ai_stage_holds h
    WHERE h.released_at IS NULL
    ORDER BY h.created_at
  `)) as unknown as { id: string; chat_titles: string[] }[];
  return rows.map((r) => ({ id: r.id, chatTitles: r.chat_titles }));
}

/** Ids of the holds open right now — what a build starting now covers. */
export async function openAiStageHoldIds(tx: TransactionRunner): Promise<string[]> {
  return (await openAiStageHolds(tx)).map((h) => h.id);
}

/**
 * The refusal message for an automatic production publish while holds are
 * open, or null when none is open. Call it after
 * {@link lockForAutomaticProductionPublish}.
 */
export async function aiStageHoldRefusal(tx: TransactionRunner): Promise<string | null> {
  const holds = await openAiStageHolds(tx);
  if (holds.length === 0) return null;
  const chats = [...new Set(holds.flatMap((h) => h.chatTitles))];
  return (
    `the AI staged changes${chats.length > 0 ? ` (chat${chats.length === 1 ? "" : "s"} ${chats.map((c) => `'${c}'`).join(", ")})` : ""} ` +
    "that wait for a human Publish live — an automatic publish never ships AI-staged work. Review staging and click Publish live."
  );
}

/**
 * Release the holds a human production publish covers: exactly the ones
 * its build recorded as open when it started.
 */
export async function releaseAiStageHolds(
  tx: TransactionRunner,
  args: { readonly holdIds: readonly string[]; readonly productionRunId: string },
): Promise<void> {
  if (args.holdIds.length === 0) return;
  await tx.execute(sql`
    UPDATE ai_stage_holds
    SET released_at = now(), released_by_run_id = ${args.productionRunId}::uuid
    WHERE released_at IS NULL
      AND id IN (${sql.join(
        args.holdIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
}
