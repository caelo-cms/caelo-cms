// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part A — the shared draft's own ops.
 *
 *   chat.merge_draft_to_main     Stage a selection of draft chats: merge
 *                                exactly their changes (closed over shared
 *                                entities — see draft.ts) into main.
 *   chat.finalize_draft_stage    after the staging build succeeded, mark
 *                                those snapshots staged and release the
 *                                draft locks nothing pending needs.
 *   chat.undo_changes            "undo this chat": drop a draft chat's
 *                                unstaged changes; when that also drops a
 *                                later change by another chat, refuse until
 *                                the caller confirms the overlap.
 *   chat.isolate_session         move a draft chat that has not changed
 *                                anything yet onto an isolated branch (an
 *                                experiment, a site migration).
 *
 * Isolated chats (experiments, migrations, legacy chats) keep using
 * chat.merge_to_main / chat.finalize_stage / chat.discard_branch.
 */

import { discardBranchPluginRows } from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  type ChatBinding,
  chatPendingSql,
  draftStageSelection,
  draftUndoSelection,
  loadChatBinding,
  pendingSnapshotSql,
  releaseIdleDraftLocks,
} from "../../draft.js";
import {
  AI_MERGE_BUSY_MESSAGE,
  enterAiMerge,
  isAiInitiated,
  recordAiStageHold,
} from "../../stage/ai-stage-hold.js";
import { mergeWindowToMain, STAGE_CHANGED_PREFIX } from "./publish.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

const affectedChatSchema = z
  .object({
    chatSessionId: z.string().nullable(),
    title: z.string(),
    labels: z.array(z.string()),
  })
  .strict();

const chatIdsSchema = z.array(z.string().uuid()).min(1).max(50);
const headerIdsSchema = z.array(z.string().uuid()).max(20000);

/**
 * Load and check the draft chats of a selection: each must exist, belong
 * to the caller, be open, and be bound to the shared draft.
 */
async function draftChats(
  tx: Tx,
  actorId: string,
  operation: string,
  ids: readonly string[],
): Promise<
  | { ok: true; bindings: ChatBinding[] }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const bindings: ChatBinding[] = [];
  for (const id of new Set(ids)) {
    const b = await loadChatBinding(tx, id);
    const problem = !b
      ? "does not exist"
      : b.createdBy !== actorId
        ? "belongs to another editor"
        : b.publishedAt !== null || b.archivedAt !== null
          ? "is closed"
          : b.kind !== "draft"
            ? `works on an isolated ${b.kind} branch — stage it with chat.merge_to_main`
            : null;
    if (problem || !b) {
      return {
        ok: false,
        error: { kind: "HandlerError", operation, message: `chat ${id} ${problem}` },
      };
    }
    bindings.push(b);
  }
  return { ok: true, bindings };
}

async function txNow(tx: Tx): Promise<string> {
  const rows = (await tx.execute(sql`
    SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
  `)) as unknown as { at: string }[];
  const at = rows[0]?.at;
  if (!at) throw new Error("could not read the transaction time");
  return at;
}

function headerFilter(ids: readonly string[]) {
  return ids.length === 0
    ? sql` AND false`
    : sql` AND ss.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;
}

/**
 * Mark exactly the merged headers staged — never "everything up to the
 * merge time": a write whose transaction started before the merge but
 * committed after it was not merged and must stay pending.
 */
async function finalizeDraftSelection(
  tx: Tx,
  branchId: string,
  chatSessionIds: readonly string[],
  headerIds: readonly string[],
  stagedAt: string,
): Promise<number> {
  let staged = 0;
  if (headerIds.length > 0) {
    const rows = (await tx.execute(sql`
      UPDATE site_snapshots SET staged_at = ${stagedAt}::timestamptz
      WHERE ${pendingSnapshotSql("site_snapshots")}
        AND chat_branch_id = ${branchId}::uuid
        AND id IN (${sql.join(
          headerIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      RETURNING 1
    `)) as unknown as unknown[];
    staged = rows.length;
  }
  await tx.execute(sql`
    UPDATE chat_sessions
    SET last_staged_at = GREATEST(COALESCE(last_staged_at, '-infinity'::timestamptz), ${stagedAt}::timestamptz)
    WHERE id IN (${sql.join(
      chatSessionIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  await releaseIdleDraftLocks(tx, branchId);
  return staged;
}

export const mergeDraftToMainOp = defineOperation({
  name: "chat.merge_draft_to_main",
  // Issue #620 Part B — the AI may Stage (stage_changes). Staging is not
  // public, the merge emits a main snapshot (revertable), and an AI merge
  // opens a production hold in this transaction: it can never reach
  // production without a human Publish live.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionIds: chatIdsSchema,
      /** Defer marking the snapshots staged until the staging build succeeded (chat.finalize_draft_stage). */
      deferConsume: z.boolean().optional(),
      /**
       * Merge exactly these headers — the set quality_audits.classify_stage
       * classified, so nothing unaudited slips in between. A header no
       * longer pending refuses the merge ("Conflict: …"; classify again).
       */
      headerIds: headerIdsSchema.optional(),
      /** The AI initiated this Stage (stage_changes): open the production hold. */
      aiInitiated: z.boolean().optional(),
    })
    .strict(),
  output: z.object({
    siteSnapshotId: z.string().nullable(),
    entityCount: z.number().int().nonnegative(),
    /** Merge time — chat.finalize_draft_stage stamps it on the merged headers. */
    mergedAt: z.string(),
    /** The merged headers — pass them to chat.finalize_draft_stage. */
    mergedHeaderIds: z.array(z.string()),
    brokenInternalLinks: z.array(z.string()),
    /** Other chats whose changes ride along because they share an entity. */
    alsoIncludes: z.array(affectedChatSchema),
  }),
  handler: async (ctx, input, tx) => {
    const chats = await draftChats(
      tx,
      ctx.actorId,
      "chat.merge_draft_to_main",
      input.chatSessionIds,
    );
    if (!chats.ok) return err(chats.error);
    const branchId = chats.bindings[0]?.branchId;
    if (!branchId) throw new Error("merge_draft_to_main: empty selection after validation");
    const ai = isAiInitiated(ctx, input.aiInitiated);
    if (ai && !(await enterAiMerge(tx))) {
      return err({
        kind: "HandlerError",
        operation: "chat.merge_draft_to_main",
        message: AI_MERGE_BUSY_MESSAGE,
      });
    }
    const mergedAt = await txNow(tx);
    const selection = await draftStageSelection(
      tx,
      branchId,
      input.chatSessionIds,
      input.headerIds,
    );
    if (selection.missingHeaderIds.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "chat.merge_draft_to_main",
        message: `${STAGE_CHANGED_PREFIX} ${selection.missingHeaderIds.length} of the checked changes were staged or undone meanwhile — nothing was merged; stage again.`,
      });
    }
    const merged = await mergeWindowToMain(
      tx,
      ctx,
      {
        branchId,
        title: `shared draft: ${chats.bindings.map((b) => b.title).join(", ")}`,
        filter: headerFilter(selection.headerIds),
        pluginCompletenessFilter: sql` AND ${pendingSnapshotSql()}`,
        graduateLayouts: false,
      },
      undefined,
      {
        opKind: "chat.merge_to_main",
        skipAlreadyPublished: false,
        honourStageFilter: false,
        recordPublishMarks: false,
        sinceLastStagedAt: true,
      },
    );
    if (!merged.ok) return err(merged.error);
    const { siteSnapshotId, entityCount, brokenInternalLinks } = merged.value;
    // Even a merge of nothing: the AI still triggers the staging build an
    // automatic publish would promote.
    if (ai) await recordAiStageHold(tx, ctx, input.chatSessionIds);
    if (!input.deferConsume) {
      await finalizeDraftSelection(
        tx,
        branchId,
        input.chatSessionIds,
        selection.headerIds,
        mergedAt,
      );
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.merge_draft_to_main",
      input,
      succeeded: true,
      resultSummary:
        `entities=${entityCount} snapshots=${selection.headerIds.length}` +
        (selection.alsoIncludes.length > 0
          ? ` also=${selection.alsoIncludes.map((a) => a.title).join("|")}`
          : ""),
    });
    return ok({
      siteSnapshotId,
      entityCount,
      mergedAt,
      mergedHeaderIds: [...selection.headerIds],
      brokenInternalLinks,
      alsoIncludes: selection.alsoIncludes.map((a) => ({ ...a, labels: [...a.labels] })),
    });
  },
});

export const finalizeDraftStageOp = defineOperation({
  name: "chat.finalize_draft_stage",
  // Issue #620 Part B — the second half of chat.merge_draft_to_main (which
  // the AI may run); called only after the staging build succeeded.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionIds: chatIdsSchema,
      /** `mergedAt` of the paired chat.merge_draft_to_main. */
      stagedAt: z.string().datetime(),
      /** `mergedHeaderIds` of the paired merge: exactly these become staged. */
      headerIds: headerIdsSchema,
    })
    .strict(),
  output: z.object({ stagedSnapshots: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    const chats = await draftChats(
      tx,
      ctx.actorId,
      "chat.finalize_draft_stage",
      input.chatSessionIds,
    );
    if (!chats.ok) return err(chats.error);
    const branchId = chats.bindings[0]?.branchId;
    if (!branchId) throw new Error("finalize_draft_stage: empty selection after validation");
    const stagedSnapshots = await finalizeDraftSelection(
      tx,
      branchId,
      input.chatSessionIds,
      input.headerIds,
      input.stagedAt,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.finalize_draft_stage",
      input,
      succeeded: true,
      resultSummary: `stagedAt=${input.stagedAt} snapshots=${stagedSnapshots}`,
    });
    return ok({ stagedSnapshots });
  },
});

/**
 * Drop a draft chat's unstaged changes (and, when `confirmed`, the later
 * changes of other chats that were built on them). Shared by
 * chat.undo_changes and chat.discard_branch for draft chats.
 *
 * @returns null when the undo needs confirmation (overlap, not confirmed).
 */
export async function undoDraftChat(
  tx: Tx,
  ctx: { actorId: string; requestId: string },
  binding: ChatBinding,
  confirmed: boolean,
  operation: string,
): Promise<{
  applied: boolean;
  undoneSnapshots: number;
  droppedRows: number;
  overlap: { chatSessionId: string | null; title: string; labels: string[] }[];
}> {
  const selection = await draftUndoSelection(tx, binding.branchId, binding.chatSessionId);
  const overlap = selection.overlap.map((o) => ({ ...o, labels: [...o.labels] }));
  if (overlap.length > 0 && !confirmed) {
    return { applied: false, undoneSnapshots: 0, droppedRows: 0, overlap };
  }
  let droppedRows = 0;
  if (selection.headerIds.length > 0) {
    await tx.execute(sql`
      UPDATE site_snapshots SET undone_at = now()
      WHERE id IN (${sql.join(
        selection.headerIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `);
  }
  for (const row of selection.createdRows) {
    const rows = (await tx.execute(sql`
      UPDATE ${sql.raw(row.table)} SET deleted_at = now()
      WHERE id = ${row.id}::uuid AND chat_branch_id = ${binding.branchId}::uuid AND deleted_at IS NULL
      RETURNING 1
    `)) as unknown as unknown[];
    droppedRows += rows.length;
  }
  droppedRows += await discardBranchPluginRows(tx, binding.branchId, selection.pluginRowIds);
  await releaseIdleDraftLocks(tx, binding.branchId);
  // The undo itself is history: one header on the draft, not pending.
  await tx.execute(sql`
    INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id, undone_at)
    VALUES (
      ${ctx.actorId}::uuid, 'chat.undo_changes',
      ${
        `${operation} chat='${binding.title}' snapshots=${selection.headerIds.length} rows=${droppedRows}` +
        (overlap.length > 0 ? ` also=${overlap.map((o) => o.title).join("|")}` : "")
      },
      ${binding.chatSessionId}::uuid, ${binding.branchId}::uuid, now()
    )
  `);
  return { applied: true, undoneSnapshots: selection.headerIds.length, droppedRows, overlap };
}

export const undoChatChangesOp = defineOperation({
  name: "chat.undo_changes",
  // Issue #620 — routine for the chat's OWN unstaged work (§11.A: the
  // change is unstaged and the undone snapshots stay in history). When it
  // would also drop another chat's later changes it refuses until
  // `confirmOverlap`; the AI tool puts that confirmed call behind a human
  // click.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      /** Also undo the later changes of the other chats listed by the refusal. */
      confirmOverlap: z.boolean().optional(),
    })
    .strict(),
  output: z.object({
    applied: z.boolean(),
    undoneSnapshots: z.number().int().nonnegative(),
    droppedRows: z.number().int().nonnegative(),
    overlap: z.array(affectedChatSchema),
  }),
  handler: async (ctx, input, tx) => {
    const binding = await loadChatBinding(tx, input.chatSessionId);
    if (!binding || binding.createdBy !== ctx.actorId) {
      return err({
        kind: "HandlerError",
        operation: "chat.undo_changes",
        message: `chat ${input.chatSessionId} not found among your chats`,
      });
    }
    if (binding.kind !== "draft") {
      return err({
        kind: "HandlerError",
        operation: "chat.undo_changes",
        message:
          "this chat works on its own isolated branch — its unstaged work is dropped by discarding the chat (Open changes → Discard), not by an undo",
      });
    }
    const result = await undoDraftChat(
      tx,
      ctx,
      binding,
      input.confirmOverlap === true,
      "chat.undo_changes",
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.undo_changes",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: result.applied
        ? `undone=${result.undoneSnapshots} rows=${result.droppedRows} overlap=${result.overlap.length}`
        : `needs-confirmation overlap=${result.overlap.map((o) => o.title).join("|")}`,
    });
    return ok(result);
  },
});

/**
 * Move a draft chat that has no unstaged changes onto a fresh isolated
 * branch. Returns null when it already has changes in the draft (they
 * would be stranded on the draft without their chat).
 */
export async function isolateDraftChat(
  tx: Tx,
  binding: ChatBinding,
  reason: "experiment" | "migration",
): Promise<{ chatBranchId: string } | null> {
  const pending = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM site_snapshots ss WHERE ${chatPendingSql(binding)}
  `)) as unknown as { n: number }[];
  if ((pending[0]?.n ?? 0) > 0) return null;
  const rows = (await tx.execute(sql`
    UPDATE chat_sessions SET chat_branch_id = gen_random_uuid(), branch_kind = ${reason}
    WHERE id = ${binding.chatSessionId}::uuid
    RETURNING chat_branch_id::text AS chat_branch_id
  `)) as unknown as { chat_branch_id: string }[];
  const chatBranchId = rows[0]?.chat_branch_id;
  if (!chatBranchId) throw new Error("isolateDraftChat: update returned no row");
  return { chatBranchId };
}

export const isolateSessionOp = defineOperation({
  name: "chat.isolate_session",
  // Issue #620 — an explicit experiment ("try a redesign") or a site
  // migration gets an isolated branch. Routine: nothing changes on the site
  // and the chat had no changes to move.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      reason: z.enum(["experiment", "migration"]),
    })
    .strict(),
  output: z.object({ chatBranchId: z.string(), branchKind: z.enum(["experiment", "migration"]) }),
  handler: async (ctx, input, tx) => {
    const binding = await loadChatBinding(tx, input.chatSessionId);
    if (!binding || binding.createdBy !== ctx.actorId) {
      return err({
        kind: "HandlerError",
        operation: "chat.isolate_session",
        message: `chat ${input.chatSessionId} not found among your chats`,
      });
    }
    if (binding.kind !== "draft") {
      return err({
        kind: "HandlerError",
        operation: "chat.isolate_session",
        message: `this chat already works on its own ${binding.kind} branch — nothing to isolate`,
      });
    }
    const moved = await isolateDraftChat(tx, binding, input.reason);
    if (!moved) {
      return err({
        kind: "HandlerError",
        operation: "chat.isolate_session",
        message:
          "this chat already has unstaged changes in the shared draft, so it cannot move to its own branch — stage or undo them first, or ask the operator to start the experiment in a new chat (Live edit → New experiment)",
      });
    }
    const chatBranchId = moved.chatBranchId;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.isolate_session",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `branch=${chatBranchId.slice(0, 8)} kind=${input.reason}`,
    });
    return ok({ chatBranchId, branchKind: input.reason });
  },
});

/**
 * Issue #569 — "may the caller see this branch?" for surfaces that hand a
 * branch to something outside the Query API (the server-side screenshot
 * renders through a signed token as the system actor). The adapter checks
 * every branch an op names against the caller BEFORE the handler runs, so
 * reaching the handler means the branch is visible; an invisible or
 * unknown branch comes back as `BranchNotFound`.
 */
export const checkBranchAccessOp = defineOperation({
  name: "chat.check_branch_access",
  // Read-only and answers only for the caller itself: every actor kind.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatBranchId: z.string().uuid() }).strict(),
  output: z.object({ visible: z.literal(true) }),
  handler: async () => ok({ visible: true as const }),
});
