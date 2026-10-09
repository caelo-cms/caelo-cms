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
 * So every AI merge into main opens a HOLD in the same transaction as the
 * merge (no window where main has AI changes without one). While a hold is
 * open, every SYSTEM-initiated production build or promote is refused
 * (`deploy.trigger` / `deploy.promote`). A human production publish — Publish
 * live, an approved promote proposal, an Owner's production build — releases
 * the holds it covers.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** Open a hold when the merge into main was made by the AI. No-op otherwise. */
export async function recordAiStageHold(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  chatSessionIds: readonly string[],
): Promise<void> {
  if (ctx.actorKind !== "ai") return;
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
export async function openAiStageHolds(
  tx: TransactionRunner,
): Promise<{ id: string; createdAt: string; chatTitles: string[] }[]> {
  const rows = (await tx.execute(sql`
    SELECT h.id::text AS id,
           to_char(h.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
           COALESCE(
             (SELECT array_agg(cs.title ORDER BY cs.title) FROM chat_sessions cs
               WHERE cs.id = ANY(h.chat_session_ids)),
             '{}'
           ) AS chat_titles
    FROM ai_stage_holds h
    WHERE h.released_at IS NULL
    ORDER BY h.created_at
  `)) as unknown as { id: string; created_at: string; chat_titles: string[] }[];
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at, chatTitles: r.chat_titles }));
}

/**
 * The refusal message for an automatic production publish while holds are
 * open, or null when none is open.
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
 * Release the holds a human production publish covers: every hold opened
 * before `coveredUntil` (the start of the staging build being promoted, or
 * now for a production build straight from main).
 */
export async function releaseAiStageHolds(
  tx: TransactionRunner,
  args: { readonly coveredUntil: string; readonly productionRunId: string | null },
): Promise<void> {
  await tx.execute(sql`
    UPDATE ai_stage_holds
    SET released_at = now(),
        released_by_run_id = ${args.productionRunId === null ? null : sql`${args.productionRunId}::uuid`}
    WHERE released_at IS NULL AND created_at <= ${args.coveredUntil}::timestamptz
  `);
}
