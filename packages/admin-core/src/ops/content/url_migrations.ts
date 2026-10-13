// SPDX-License-Identifier: MPL-2.0

/**
 * #390 — the generic URL-diff engine (epic #380 decision 4): ANY change
 * to the URL-contribution set (plugin activate / deactivate /
 * reconfigure) is a migration event, never a silent reshuffle.
 *
 * `url_migrations.propose_migrate` diffs every live page's MATERIALIZED
 * `current_path` against a fresh resolution through the composition
 * point, stores the full page diff as a §11.A proposal with a
 * blast-radius preview (N pages move, N redirects), and
 * `url_migrations.execute_proposal` applies it in one transaction:
 * per moved page a 301 from the old path + the current_path update.
 *
 * Because the diff compares STORED paths, it works even after the
 * causing plugin is gone — deactivating a URL plugin diffs back to the
 * composition-free shape from the same stored state. (Reference: the
 * deleted `locales.execute_proposal` redirect fan-out, git 987e23aa^.)
 *
 * The empty diff is an AI-actionable refusal, not a junk proposal row:
 * activation retrofits where the URL shape doesn't change (#395's
 * default-locale-bare case) need no operator click at all.
 */

import { MAIN_RENDER } from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { requiresApproverPermission } from "../_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { createRedirectOp } from "../redirects.js";
import { resolveCurrentPathsDryRun } from "./current-path.js";

export interface UrlMigrationDiffEntry {
  readonly pageId: string;
  readonly slug: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Compute the live-page URL diff: stored current_path vs a fresh
 * resolution through the active contribution set. Exported for the
 * activation flows (#393/#395) that check for the zero-diff retrofit
 * before deciding whether an Owner click is needed.
 */
export async function computeUrlMigrationDiff(
  tx: Parameters<NonNullable<(typeof createRedirectOp)["handler"]>>[2],
): Promise<UrlMigrationDiffEntry[]> {
  const pages = (await tx.execute(sql`
    SELECT id::text AS id, slug, current_path
    FROM pages
    WHERE deleted_at IS NULL AND chat_branch_id IS NULL
    ORDER BY slug ASC
  `)) as unknown as { id: string; slug: string; current_path: string }[];
  const fresh = await resolveCurrentPathsDryRun(
    tx,
    pages.map((p) => ({ id: p.id, slug: p.slug })),
    // The diff compares live paths against live plugin state.
    MAIN_RENDER,
  );
  const diff: UrlMigrationDiffEntry[] = [];
  for (const p of pages) {
    const next = fresh.get(p.id);
    if (next === undefined) {
      throw new Error(`url_migrations: no resolution for page ${p.id} (${p.slug})`);
    }
    if (next !== p.current_path) {
      diff.push({ pageId: p.id, slug: p.slug, from: p.current_path, to: next });
    }
  }
  return diff;
}

/**
 * Apply a URL diff: per moved page the current_path update + a 301 from
 * the old path, in the CALLER'S tx. Loud staleness guard — a page that
 * no longer sits at the diff's `from` aborts the whole tx (applying
 * would write stale paths + wrong redirects; the caller re-diffs).
 * Shared by url_migrations.execute_proposal and the gated plugin
 * uninstall (#393), which must move URLs back when a URL-contributing
 * plugin is removed.
 */
export async function applyUrlMigrationDiff(
  ctx: Parameters<NonNullable<(typeof createRedirectOp)["handler"]>>[0],
  tx: Parameters<NonNullable<(typeof createRedirectOp)["handler"]>>[2],
  diff: ReadonlyArray<UrlMigrationDiffEntry>,
): Promise<{ redirectsCreated: number }> {
  let redirectsCreated = 0;
  for (const entry of diff) {
    const updated = (await tx.execute(sql`
      UPDATE pages
         SET current_path = ${entry.to}, updated_at = now()
       WHERE id = ${entry.pageId}::uuid AND current_path = ${entry.from}
       RETURNING id
    `)) as unknown as { id: string }[];
    if (updated.length === 0) {
      throw new Error(
        `url migration aborted — page ${entry.pageId} no longer sits at ${entry.from} (stale proposal; re-propose)`,
      );
    }
    const red = await createRedirectOp.handler(
      ctx,
      { fromPath: entry.from, toPath: entry.to, statusCode: 301 },
      tx,
    );
    if (!red.ok) {
      throw new Error(
        `url migration aborted — redirect ${entry.from} → ${entry.to} failed to land`,
      );
    }
    redirectsCreated += 1;
  }
  return { redirectsCreated };
}

const proposeInput = z
  .object({
    /** Operator-facing context for the proposal card. */
    reason: z.string().max(500).optional(),
  })
  .strict();

export const proposeUrlMigrationOp = defineOperation({
  name: "url_migrations.propose_migrate",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const diff = await computeUrlMigrationDiff(tx);
    if (diff.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "url_migrations.propose_migrate",
        message:
          "no URL changes — every page's current_path already matches the active contribution set. Nothing to migrate; no approval needed.",
      });
    }
    const payload = { diff, reason: input.reason ?? null };
    const preview = {
      pagesMoved: diff.length,
      redirectsToCreate: diff.length,
      sample: diff.slice(0, 10).map((d) => `${d.from} → ${d.to}`),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
    try {
      const rows = (await tx.execute(sql`
        INSERT INTO url_migration_pending_actions
          (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES (
          'migrate',
          ${ctx.actorId}::uuid,
          (${JSON.stringify(payload)}::text)::jsonb,
          (${JSON.stringify(preview)}::text)::jsonb,
          'pending',
          ${chatSessionId}::uuid,
          ${await hashProposalPayload(payload)}
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const proposalId = rows[0]?.id;
      if (!proposalId) throw new Error("url_migrations.propose_migrate: insert returned no id");
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "url_migrations.propose_migrate",
        input,
        succeeded: true,
        entityId: proposalId,
        resultSummary: `pages=${diff.length}`,
      });
      return ok({ proposalId, preview });
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({
          kind: "HandlerError",
          operation: "url_migrations.propose_migrate",
          message: DUPLICATE_PROPOSAL_MESSAGE,
        });
      }
      throw e;
    }
  },
});

const executeUrlMigrationOpDefinition = defineOperation({
  name: "url_migrations.execute_proposal",
  // Why human-only (+system): §11.A — applying a site-wide URL move is
  // the click the gate exists to obtain. The AI proposes; the SDK
  // approval (or the /settings/pending queue) executes.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ pagesMoved: z.number(), redirectsCreated: z.number() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, status, payload
      FROM url_migration_pending_actions
      WHERE id = ${input.proposalId}::uuid
      FOR UPDATE
    `)) as unknown as { id: string; status: string; payload: unknown }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "url_migrations.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "url_migrations.execute_proposal",
        message: `proposal is '${row.status}', not pending`,
      });
    }
    const payload = row.payload as { diff: UrlMigrationDiffEntry[] };
    const { redirectsCreated } = await applyUrlMigrationDiff(ctx, tx, payload.diff);
    await tx.execute(sql`
      UPDATE url_migration_pending_actions
         SET status = 'applied', decided_by = ${ctx.actorId}::uuid, decided_at = now()
       WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "url_migrations.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `pages=${payload.diff.length} redirects=${redirectsCreated}`,
    });
    return ok({ pagesMoved: payload.diff.length, redirectsCreated });
  },
});

/** #589 — the approver must hold roles.manage (see _approver-permission.ts). */
export const executeUrlMigrationOp = requiresApproverPermission(
  ["roles.manage"],
  executeUrlMigrationOpDefinition,
);

const pendingRow = z.object({
  id: z.string(),
  kind: z.literal("migrate"),
  proposedBy: z.string(),
  preview: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

/**
 * #684 — the pending URL migrations, for `/settings/url_migrations/pending`.
 * In the chat the gated tool proposes and applies in one approved step; a
 * proposal queued over the Power-MCP (no in-chat card) or one whose card
 * the operator skipped waits here. Before this op nothing listed those
 * rows, so the chat's pending strip posted Approve to a page that did not
 * exist.
 */
export const listUrlMigrationPendingOp = defineOperation({
  name: "url_migrations.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({ proposals: z.array(pendingRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, proposed_by::text AS proposed_by, preview, created_at
      FROM url_migration_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${input.limit ?? 50}
    `)) as unknown as Array<{
      id: string;
      proposed_by: string;
      preview: unknown;
      created_at: string | Date;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: "migrate" as const,
        proposedBy: r.proposed_by,
        preview: parsePayload<Record<string, unknown>>(r.preview),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

export const rejectUrlMigrationOp = defineOperation({
  name: "url_migrations.reject_proposal",
  // Why human-only (+system): §11.A — the operator's Reject.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE url_migration_pending_actions
         SET status = 'rejected', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
             decision_reason = ${input.reason ?? null}
       WHERE id = ${input.proposalId}::uuid AND status = 'pending'
       RETURNING id
    `)) as unknown as { id: string }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "url_migrations.reject_proposal",
        message: "proposal not found or already decided — reload the queue",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "url_migrations.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});
