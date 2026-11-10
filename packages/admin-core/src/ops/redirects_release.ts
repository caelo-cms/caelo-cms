// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — redirects past the draft: what a Publish live ships, and Go live
 * now (docs/dev/redirects-and-settings-sync.md).
 *
 *   redirects.release_plan     the shared draft's pending changes sorted into
 *                              going live, waiting for their target and
 *                              staying in draft, against the build that goes
 *                              live (the Publish live confirmation, the
 *                              publish gate, list_unpublished_changes; and
 *                              deploy.promote / an Owner's production build
 *                              decide with it).
 *   redirects.go_live_now      a human's one click past Publish live for
 *                              manual changes: live on the hosting now,
 *                              with the Publish live permission.
 *   redirects.propose_go_live  the AI's way there (§11.A): a proposal the
 *                              operator approves on its card in the chat.
 *   redirects.execute_go_live  the approval: Go live now as the approver,
 *                              who needs the Publish live permission.
 *
 * Go live now refuses, with the reason and the next step: an automatic
 * change (it goes live with its page change), a same-site target the live
 * build does not serve, a from path a live page serves (the page wins, the
 * rule would do nothing), an isolated branch's change, and an install with
 * nothing live yet. All refusals of a call at once; nothing goes live when
 * one is refused.
 */

import {
  defineOperation,
  defineReadOperation,
  defineStepwiseOperation,
  type ErrorDetail,
  execute,
  handlerErrorFromDetails,
  textArray,
} from "@caelo-cms/query-api";
import {
  err,
  isExternalRedirectTarget,
  ok,
  planRedirectRelease,
  type RedirectTableRow,
  redirectAddress,
  redirectPathServed,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import {
  markRedirectsBehind,
  type RedirectSyncOutcome,
  syncRedirects,
} from "../deploy/redirect-sync.js";
import {
  liveBuildFiles,
  loadProductionTargets,
  loadStagedBuild,
  stagedBuildFiles,
} from "../redirects/build-files.js";
import {
  loadDraftChanges,
  loadLiveRedirectRows,
  loadStagedChanges,
  PENDING_COLUMNS,
  type PendingDbRow,
  type PendingRedirectRow,
  pendingRowOf,
  plannedChangeOf,
} from "../redirects/model.js";
import { releaseRedirectChanges } from "../redirects/release.js";
import { jsonbParam } from "../sql-helpers.js";
import { requiresApproverPermission } from "./_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { actorHasPermission } from "./quality/_permissions.js";

/** A change as a release plan lists it. */
const plannedChangeSchema = z.object({
  id: z.string(),
  /** Pass `{id, revision}` to deploy.promote's `redirectChanges` to bind a confirmation. */
  revision: z.number().int(),
  fromPath: z.string(),
  /** Null: the change removes the rule. */
  toPath: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  origin: z.enum(["manual", "page_move", "page_delete", "url_migration", "revert", "plugin"]),
  /** The live rule the change replaces, if any. */
  live: z.object({ toPath: z.string(), statusCode: z.number().int() }).nullable(),
});

/** A change of a release plan. */
export type PlannedRedirectChange = z.infer<typeof plannedChangeSchema>;

const changeRefSchema = z
  .object({ id: z.string().uuid(), revision: z.number().int().min(1) })
  .strict();

const releasePlanOutput = z.object({
  /** The staged build the plan was made against (`against: "staged"`). */
  stagedRunId: z.string().nullable(),
  /** Staged changes the build serves: they go live with it. */
  goingLive: z.array(plannedChangeSchema),
  /** Staged changes left out: their target (or, `page`, the page at their address) is not in the build. */
  waiting: z.array(plannedChangeSchema.extend({ reason: z.enum(["target", "page"]) })),
  /** Draft changes: served nowhere, held back by every Publish live. */
  draft: z.array(plannedChangeSchema),
  /** Set when the plan could not be made: why, with the next step. Nothing goes live then. */
  problem: z.string().nullable(),
  /**
   * With `includeRows`: the table the build is served with, every live row
   * (both spellings) with the going-live changes applied, as the staging
   * gateway serves it against the staged build. Null otherwise, and when
   * the plan could not be made.
   */
  rows: z
    .array(z.object({ fromPath: z.string(), toPath: z.string(), statusCode: z.number().int() }))
    .nullable(),
});

/** What {@link releasePlanOp} returns. */
export type RedirectReleasePlan = z.infer<typeof releasePlanOutput>;

function plannedOf(
  c: PendingRedirectRow,
  liveByAddress: ReadonlyMap<string, RedirectTableRow>,
): PlannedRedirectChange {
  const live = liveByAddress.get(c.address) ?? null;
  return {
    id: c.id,
    revision: c.revision,
    fromPath: c.fromPath,
    toPath: c.toPath,
    statusCode: c.statusCode,
    origin: c.origin,
    live: live ? { toPath: live.toPath, statusCode: live.statusCode } : null,
  };
}

export const releasePlanOp = defineReadOperation({
  name: "redirects.release_plan",
  // Why site-wide: what a release ships is the whole live table with every
  // Staged change, checked against every file of the build going live.
  readScope: "site",
  actorScope: ["human", "ai", "system"],
  input: z
    .object({
      /** The staging target a Publish live copies from. */
      fromTarget: z.string().min(1).max(80).default("staging"),
      /** The staged run to plan against; default the newest (what Publish live copies). */
      stagedRunId: z.string().uuid().optional(),
      /**
       * Only these changes, by id and the revision a confirmation listed (a
       * change saved since is left out: it waits for the next Publish live).
       * Default: every Staged change of the shared draft.
       */
      changes: z.array(changeRefSchema).max(20_000).optional(),
      /**
       * `staged`: against the staged build (Publish live); `live`: against
       * what production serves now (an Owner's production build, after its
       * release).
       */
      against: z.enum(["staged", "live"]).default("staged"),
      /** Also return the served table (`rows`): the Stage audit's links check reads it. */
      includeRows: z.boolean().default(false),
      repoRoot: z.string().optional(),
    })
    .strict(),
  output: releasePlanOutput,
  handler: async (_ctx, input, reads) => {
    const read = await reads.read(async (tx) => {
      const staged = await loadStagedChanges(tx);
      const listed = input.changes
        ? new Map(input.changes.map((c) => [c.id.toLowerCase(), c.revision]))
        : null;
      const candidates =
        listed === null ? staged : staged.filter((c) => listed.get(c.id) === c.revision);
      const drafts = input.changes ? [] : await loadDraftChanges(tx);
      const live = candidates.length > 0 || input.includeRows ? await loadLiveRedirectRows(tx) : [];
      let build: Awaited<ReturnType<typeof loadStagedBuild>> = null;
      if (candidates.length > 0 && input.against === "staged") {
        build = await loadStagedBuild(tx, input.fromTarget);
        if (build && input.stagedRunId && build.runId !== input.stagedRunId) {
          // Publish live copies the run it was started for; plan against it.
          const pinned = (await tx.execute(sql`
            SELECT r.publish_summary->>'stagingLocation' AS location
            FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
            WHERE r.id = ${input.stagedRunId}::uuid AND t.name = ${input.fromTarget}
              AND r.status = 'succeeded'
          `)) as unknown as { location: string | null }[];
          const location = pinned[0]?.location;
          build = location ? { ...build, runId: input.stagedRunId, location } : null;
        }
      }
      const production =
        candidates.length > 0 && input.against === "live" ? await loadProductionTargets(tx) : [];
      return { candidates, drafts, live, build, production };
    });
    const liveByAddress = new Map(read.live.map((r) => [redirectAddress(r.fromPath), r]));
    const draft = read.drafts.map((c) => plannedOf(c, liveByAddress));
    const nothing = { goingLive: [], waiting: [], draft, rows: null };
    if (read.candidates.length === 0) {
      return ok({
        stagedRunId: read.build?.runId ?? null,
        ...nothing,
        problem: null,
        rows: input.includeRows ? read.live : null,
      });
    }
    const outputRoot = resolveOutputRoot(input.repoRoot);
    let files: ReadonlySet<string>;
    let pageUrlStyle: "directory" | "no-extension";
    try {
      if (input.against === "staged") {
        if (read.build === null) {
          return ok({
            stagedRunId: null,
            ...nothing,
            problem:
              "Nothing that Publish live could ship is staged (or the staged build is from an older Caelo release). Stage first.",
          });
        }
        files = await stagedBuildFiles(read.build, outputRoot);
        pageUrlStyle = read.build.pageUrlStyle;
      } else {
        const target = read.production[0];
        const served = target ? await liveBuildFiles(target, outputRoot) : null;
        if (!target || served === null) {
          return ok({
            stagedRunId: null,
            ...nothing,
            problem: "Nothing is live yet, so no redirect change can go live against it.",
          });
        }
        files = served;
        pageUrlStyle = target.pageUrlStyle ?? "directory";
      }
    } catch (e) {
      return ok({
        stagedRunId: read.build?.runId ?? null,
        ...nothing,
        problem: `The files of the build going live could not be read (${e instanceof Error ? e.message : String(e)}).`,
      });
    }
    let release: ReturnType<typeof planRedirectRelease>;
    try {
      release = planRedirectRelease({
        live: read.live,
        changes: read.candidates.map(plannedChangeOf),
        servedFiles: files,
        pageUrlStyle,
      });
    } catch (e) {
      return ok({
        stagedRunId: read.build?.runId ?? null,
        ...nothing,
        problem: `The redirects going live cannot be served: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const byId = new Map(read.candidates.map((c) => [c.id, c]));
    const applied = new Set(release.applied);
    return ok({
      stagedRunId: read.build?.runId ?? null,
      goingLive: read.candidates
        .filter((c) => applied.has(c.id))
        .map((c) => plannedOf(c, liveByAddress)),
      waiting: release.waiting.flatMap((w) => {
        const c = byId.get(w.id);
        return c ? [{ ...plannedOf(c, liveByAddress), reason: w.reason }] : [];
      }),
      draft,
      problem: null,
      rows: input.includeRows ? [...release.rows] : null,
    });
  },
});

// ---------------------------------------------------------------------
// Go live now.
// ---------------------------------------------------------------------

const fromPathsSchema = z.array(z.string().min(1).max(500)).min(1).max(500);

/** Load and check the pending changes a Go live now names. */
async function goLiveCandidates(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  fromPaths: readonly string[],
): Promise<{ rows: PendingRedirectRow[]; problems: ErrorDetail[] }> {
  const addresses = fromPaths.map((p) => redirectAddress(p));
  const rows = (
    (await tx.execute(sql`
      SELECT ${PENDING_COLUMNS} FROM pending_redirects p WHERE p.address = ANY(${textArray(addresses)})
    `)) as unknown as PendingDbRow[]
  ).map(pendingRowOf);
  const byAddress = new Map(rows.map((r) => [r.address, r]));
  const problems: ErrorDetail[] = [];
  const out: PendingRedirectRow[] = [];
  for (const [i, address] of addresses.entries()) {
    const row = byAddress.get(address);
    const path = ["fromPaths", i];
    if (!row) {
      problems.push({
        path,
        message: `${fromPaths[i]} has no pending change`,
        next: "save the rule first (bulk_create_redirects / bulk_delete_redirects); find_redirects lists the pending changes",
      });
    } else if (row.origin !== "manual") {
      problems.push({
        path,
        message: `${fromPaths[i]} is an automatic change (${row.origin}): it goes live only with the Publish live that ships its page change`,
        next: "Stage the page change and Publish live",
      });
    } else if (row.isolated) {
      problems.push({
        path,
        message: `${fromPaths[i]} was saved in an experiment chat: it joins the site at that chat's Stage`,
        next: "Stage that chat first",
      });
    } else if (!out.some((o) => o.id === row.id)) {
      out.push(row);
    }
  }
  return { rows: out, problems };
}

/** A Go live now that found its changes moved on between the check and the write. */
class MovedOnError extends Error {
  override readonly name = "MovedOnError";
}

const goLiveOutput = z.object({
  /** The changes that are live now. */
  applied: z.array(
    z.object({
      fromPath: z.string(),
      toPath: z.string().nullable(),
      statusCode: z.number().int().nullable(),
    }),
  ),
  /** The push to the hosting, per production target (a failure is retried). */
  targets: z.array(
    z.object({
      targetName: z.string(),
      status: z.enum(["applied", "unchanged", "not-served", "nothing-live", "failed"]),
      error: z.string().nullable(),
    }),
  ),
});

export const goLiveNowOp = defineOperation({
  name: "redirects.go_live_now",
  // Why site-wide: the check runs the whole live table with these changes
  // against every file of the live build.
  readScope: "site",
  // Why human-only: Go live now puts a change live without Publish live,
  // which is a human decision (CLAUDE.md §2). The AI reaches it only through
  // its approval card (redirects.propose_go_live → redirects.execute_go_live,
  // run as the approver), and a human needs the Publish live permission.
  // No system caller either: like a production Publish live (#1154), no
  // worker or tick may put a change live.
  actorScope: ["human"],
  database: "cms_admin",
  // Provider I/O (the live build's files, the push): no transaction may stay
  // open across it; the steps run their own short ones.
  transaction: "none",
  input: z
    .object({
      /** The from paths of manual pending changes (Draft or Staged). */
      fromPaths: fromPathsSchema,
      /** Where relative out_dirs resolve (deploy ops' `repoRoot`). */
      repoRoot: z.string().optional(),
    })
    .strict(),
  output: goLiveOutput,
  handler: async (ctx, input, tx) => {
    const op = "redirects.go_live_now";
    const checked = await tx.transaction(async (t) => {
      if (!(await actorHasPermission(t, ctx, "deploy.trigger"))) {
        return { refused: true as const };
      }
      const candidates = await goLiveCandidates(t, input.fromPaths);
      return {
        refused: false as const,
        ...candidates,
        live: await loadLiveRedirectRows(t),
        targets: await loadProductionTargets(t),
      };
    });
    if (checked.refused) {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "Go live now puts a redirect live without Publish live, so it needs the Publish live permission (deploy.trigger), which your role does not have. The change stays as it is; it goes live with the next Publish live.",
        refusal: true,
      });
    }
    if (checked.problems.length > 0) {
      return err(handlerErrorFromDetails(op, checked.problems, { lead: "Nothing went live." }));
    }
    if (checked.targets.length === 0) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: "this install has no production target, so nothing can go live",
        refusal: true,
      });
    }
    const outputRoot = resolveOutputRoot(input.repoRoot);
    const problems: ErrorDetail[] = [];
    for (const target of checked.targets) {
      const files = await liveBuildFiles(target, outputRoot);
      if (files === null) {
        return err({
          kind: "HandlerError",
          operation: op,
          message: `nothing is live on ${target.name} yet, so there is no live site to put a redirect in front of. The change stays Staged and goes live with the first Publish live.`,
          refusal: true,
        });
      }
      let release: ReturnType<typeof planRedirectRelease>;
      try {
        release = planRedirectRelease({
          live: checked.live,
          changes: checked.rows.map(plannedChangeOf),
          servedFiles: files,
          pageUrlStyle: target.pageUrlStyle ?? "directory",
        });
      } catch (e) {
        return err({
          kind: "HandlerError",
          operation: op,
          message: `Nothing went live: with these changes the live redirects could not be served (${e instanceof Error ? e.message : String(e)}).`,
        });
      }
      const waiting = new Set(release.waiting.map((w) => w.id));
      for (const [i, p] of input.fromPaths.entries()) {
        const row = checked.rows.find((r) => r.address === redirectAddress(p));
        if (!row || row.toPath === null) continue;
        if (redirectPathServed(row.address, files)) {
          problems.push({
            path: ["fromPaths", i],
            message: `a live page answers ${p}, so the rule would do nothing there (the page wins over a redirect)`,
            next: "move or unpublish the page first, or keep the change for after it",
          });
        } else if (waiting.has(row.id) && !isExternalRedirectTarget(row.toPath)) {
          problems.push({
            path: ["fromPaths", i],
            message: `its target ${row.toPath} is not on the live site yet`,
            next: "it goes live with the Publish live that ships that page; keep it Staged",
          });
        }
      }
    }
    if (problems.length > 0) {
      return err(handlerErrorFromDetails(op, problems, { lead: "Nothing went live." }));
    }
    const targetIds = checked.targets.map((t) => t.id);
    let applied: Awaited<ReturnType<typeof releaseRedirectChanges>>;
    try {
      applied = await tx.transaction(async (t) => {
        const released = await releaseRedirectChanges(
          t,
          ctx.actorId,
          checked.rows.map((r) => ({ id: r.id, revision: r.revision })),
          { kind: "go_live_now" },
          ["draft", "staged"],
        );
        if (released.length !== checked.rows.length) throw new MovedOnError();
        await markRedirectsBehind(t, targetIds);
        await recordAudit(t, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: op,
          input: { fromPaths: input.fromPaths },
          succeeded: true,
          resultSummary: released
            .map((r) => `${r.fromPath} → ${r.toPath ?? "(removed)"}`)
            .join(", ")
            .slice(0, 500),
        });
        return released;
      });
    } catch (e) {
      if (!(e instanceof MovedOnError)) throw e;
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "Nothing went live: one of these changes was saved again while it was checked. Look at it again (find_redirects) and Go live now again.",
        conflict: true,
      });
    }
    const outcomes = await syncRedirects(tx, ctx, {
      trigger: "go_live",
      ...(input.repoRoot ? { outputRoot } : {}),
    });
    return ok({
      applied: applied.map((r) => ({
        fromPath: r.fromPath,
        toPath: r.toPath,
        statusCode: r.statusCode,
      })),
      targets: outcomes
        .filter((o: RedirectSyncOutcome) => o.env === "production")
        .map((o) => ({ targetName: o.targetName, status: o.status, error: o.error })),
    });
  },
});

const goLivePayload = z.object({ fromPaths: fromPathsSchema.max(100) }).strict();

export const proposeGoLiveOp = defineOperation({
  name: "redirects.propose_go_live",
  readScope: "request",
  // §11.A — the AI proposes Go live now; the operator approves the card.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: goLivePayload,
  output: z.object({ proposalId: z.string(), preview: z.record(z.string(), z.unknown()) }),
  handler: async (ctx, input, tx) => {
    const op = "redirects.propose_go_live";
    const { rows, problems } = await goLiveCandidates(tx, input.fromPaths);
    if (problems.length > 0) {
      return err(handlerErrorFromDetails(op, problems, { lead: "Nothing was proposed." }));
    }
    const lines = rows.map((r) =>
      r.toPath === null
        ? `${r.fromPath} (removed)`
        : `${r.fromPath} → ${r.toPath} (${r.statusCode})`,
    );
    const preview = {
      summary: `go live now without Publish live: ${lines.join(", ")}`.slice(0, 400),
      changes: rows.map((r) => ({
        fromPath: r.fromPath,
        toPath: r.toPath,
        statusCode: r.statusCode,
        state: r.state,
      })),
      effect:
        "Live on the hosting right after approval, without Publish live. Approving needs the Publish live permission.",
    };
    const payload = { fromPaths: rows.map((r) => r.fromPath) };
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
    const payloadHash = await hashProposalPayload({ kind: "go_live_now", ...payload });
    try {
      const inserted = (await tx.execute(sql`
        INSERT INTO redirect_pending_actions
          (kind, proposed_by, payload, preview, chat_session_id, payload_hash)
        VALUES ('go_live_now', ${ctx.actorId}::uuid, ${jsonbParam(payload)}, ${jsonbParam(preview)},
                ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`}, ${payloadHash})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const id = inserted[0]?.id;
      if (!id) return err({ kind: "HandlerError", operation: op, message: "no id" });
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: payload,
        succeeded: true,
        entityId: id,
        resultSummary: preview.summary,
      });
      return ok({ proposalId: id, preview });
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({ kind: "HandlerError", operation: op, message: DUPLICATE_PROPOSAL_MESSAGE });
      }
      throw e;
    }
  },
});

const executeGoLiveDefinition = defineStepwiseOperation({
  name: "redirects.execute_go_live",
  // Why site-wide: it runs redirects.go_live_now, which checks the whole
  // live table against the live build.
  readScope: "site",
  // Why human-only: the operator's Approve click of the §11.A gate — the AI
  // proposes, it can never approve its own proposal, and no worker may.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid(), repoRoot: z.string().optional() }).strict(),
  output: goLiveOutput,
  stepwise: async (ctx, input, steps) => {
    const op = "redirects.execute_go_live";
    const found = await steps.adapter.withAdminTransaction(
      ctx,
      async (tx) =>
        (await tx.execute(sql`
          SELECT payload, status FROM redirect_pending_actions
          WHERE id = ${input.proposalId}::uuid AND kind = 'go_live_now'
        `)) as unknown as { payload: unknown; status: string }[],
      { holder: op },
    );
    const row = found[0];
    if (!row) return err({ kind: "HandlerError", operation: op, message: "proposal not found" });
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = goLivePayload.parse(row.payload);
    const applied = await execute(steps.registry, steps.adapter, ctx, "redirects.go_live_now", {
      fromPaths: payload.fromPaths,
      ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
    });
    // Refused: the proposal stays pending, the card shows why; reject it or
    // approve again once the reason is gone.
    if (!applied.ok) return err(applied.error);
    await steps.adapter.withAdminTransaction(
      ctx,
      async (tx) => {
        await tx.execute(sql`
          UPDATE redirect_pending_actions
          SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
          WHERE id = ${input.proposalId}::uuid AND status = 'pending'
        `);
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: op,
          input,
          succeeded: true,
          entityId: input.proposalId,
          resultSummary: payload.fromPaths.join(", ").slice(0, 500),
        });
      },
      { holder: op },
    );
    return ok(applied.value as z.infer<typeof goLiveOutput>);
  },
});

/** #589 — the approver needs the Publish live permission, as for Go live now itself. */
export const executeGoLiveOp = requiresApproverPermission(
  ["deploy.trigger"],
  executeGoLiveDefinition,
);
