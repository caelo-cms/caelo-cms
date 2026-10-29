// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — ops around the Publish-live gate:
 *
 *   quality_audits.gate_status               may the staged build go live, and
 *                                            if not, why and what next.
 *   quality_audits.retry                     re-run a failed (or missing)
 *                                            audit of the staged build.
 *   quality_audits.chat_status               the newest audit of a chat plus
 *                                            the message the chat should get
 *                                            (#685: problems are an offer the
 *                                            operator must click).
 *   quality_audits.claim_chat_notification   claim that message exactly once.
 *   quality_audits.release_chat_notification give back a claimed fix request
 *                                            that started no turn (#685).
 *   quality_audits.publish_anyway            an editor's recorded decision to
 *                                            publish over a FAILED audit.
 */

import {
  defineOperation,
  defineStepwiseOperation,
  execute,
  OperationAbortError,
} from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  type ChatAuditSummary,
  chatFeedbackFor,
  fixDistance,
  fixPromptFor,
} from "../../quality/chat-feedback.js";
import { CURRENT_GATE_RULES, decideGate, type GateDecision } from "../../quality/gate.js";
import { groupOpenProblems, topProblemGroups } from "../../quality/problem-groups.js";
import { appendChatMessageOp } from "../chat/messages.js";
import { actorHasPermission } from "./_permissions.js";
import { categorySchema, uuidList } from "./_shared.js";
import {
  latestSucceededRun,
  loadAcceptances,
  loadGateAuditById,
  publishGateForRun,
} from "./gate-loader.js";
import { enqueueAuditOp } from "./lifecycle.js";
import { RUN_COLUMNS, type RunDbRow, runSummarySchema, toRunSummary } from "./read.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

const gateSchema = z.object({
  open: z.boolean(),
  state: z.enum(["clean", "accepted", "overridden", "missing", "running", "problems", "errored"]),
  auditRunId: z.string().nullable(),
  message: z.string(),
  canPublishAnyway: z.boolean(),
  openProblemCount: z.number().int(),
  /** #1207 — the open problems grouped by rule, largest groups first (at most 5). */
  topProblems: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      pageCount: z.number().int(),
      pages: z.array(z.object({ pagePath: z.string(), detail: z.string() })),
    }),
  ),
  /** How many groups there are in all; more than `topProblems` lists means "and N more". */
  problemGroupCount: z.number().int(),
});

const gateStatusOutput = z.object({
  /** The staged deploy run Publish would ship (null: nothing staged). */
  deployRunId: z.string().nullable(),
  gate: gateSchema.nullable(),
});

function gateView(
  deployRunId: string | null,
  g: GateDecision | null,
): z.infer<typeof gateStatusOutput> {
  if (deployRunId === null || g === null) return { deployRunId: null, gate: null };
  const groups = groupOpenProblems(g.openProblems);
  return {
    deployRunId,
    gate: {
      open: g.open,
      state: g.state,
      auditRunId: g.auditRunId,
      message: g.message,
      canPublishAnyway: g.canPublishAnyway,
      openProblemCount: g.openProblems.length,
      topProblems: topProblemGroups(groups),
      problemGroupCount: groups.length,
    },
  };
}

async function gateFor(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  fromTarget: string,
): Promise<z.infer<typeof gateStatusOutput>> {
  const run = await latestSucceededRun(tx, fromTarget);
  if (!run) return { deployRunId: null, gate: null };
  return gateView(run.id, await publishGateForRun(tx, run.id));
}

export const gateStatusOp = defineOperation({
  name: "quality_audits.gate_status",
  // CLAUDE.md §11: read-only — the AI checks whether Publish live is open
  // before suggesting it, and reads the next step when it is not.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ fromTarget: z.string().min(1).default("staging") }).strict(),
  output: gateStatusOutput,
  handler: async (_ctx, input, tx) => ok(await gateFor(tx, input.fromTarget)),
});

export const retryAuditOp = defineOperation({
  name: "quality_audits.retry",
  // Routine and harmless: re-measures the build that is already staged and
  // changes nothing on the site, so the AI may run it too (§11 default).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ fromTarget: z.string().min(1).default("staging") }).strict(),
  output: z.object({ auditRunId: z.string(), status: z.enum(["queued", "skipped"]) }),
  handler: async (ctx, input, tx) => {
    const run = await latestSucceededRun(tx, input.fromTarget);
    if (run?.env !== "staging") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.retry",
        message: `nothing staged on '${input.fromTarget}' to audit — Stage first`,
      });
    }
    const latest = (await tx.execute(sql`
      SELECT id::text AS id, status, gate_rules, chat_session_id::text AS chat_session_id,
             classification, target_page_ids::text[] AS target_page_ids, performance_runs, fix_round
      FROM quality_audit_runs WHERE deploy_run_id = ${run.id}::uuid
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as {
      id: string;
      status: string;
      gate_rules: number;
      chat_session_id: string | null;
      classification: unknown;
      target_page_ids: string[];
      performance_runs: number;
      fix_round: number;
    }[];
    const prev = latest[0];
    // #727 — a settled audit recorded under older gate rules is not
    // trusted (it let scores below 100 pass): check the build again, like
    // one that was never audited, with Lighthouse on the recent pages.
    const outdated =
      prev !== undefined &&
      Number(prev.gate_rules) < CURRENT_GATE_RULES &&
      (prev.status === "passed" || prev.status === "problems" || prev.status === "skipped");
    if (!prev || prev.status === "superseded" || outdated) {
      // Never audited (e.g. staged before the gate existed, or the enqueue
      // failed): audit it like a Stage outside a chat.
      // Nothing says which pages this Stage touched, so audit the pages
      // edited most recently (the homepage is always added first).
      const recent = (await tx.execute(sql`
        SELECT id::text AS id FROM pages
        WHERE status = 'published' AND deleted_at IS NULL AND chat_branch_id IS NULL
        ORDER BY updated_at DESC LIMIT 10
      `)) as unknown as { id: string }[];
      const r = await enqueueAuditOp.handler(
        ctx,
        {
          deployRunId: run.id,
          chatSessionId: null,
          branch: null,
          pageIds: recent.map((p) => p.id),
          stagedBy: null,
        },
        tx,
      );
      if (!r.ok) return r;
      return ok({ auditRunId: r.value.auditRunId, status: r.value.status });
    }
    if (prev.status !== "errored") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.retry",
        message:
          prev.status === "queued" || prev.status === "running"
            ? "the quality check of the staged build is still running — wait for it instead of retrying"
            : `the quality check of the staged build ended '${prev.status}', it did not fail — to re-check after fixes, Stage again`,
      });
    }
    const inserted = (await tx.execute(sql`
      INSERT INTO quality_audit_runs
        (deploy_run_id, chat_session_id, requested_by, status, classification,
         target_page_ids, performance_runs, fix_round, staged_by, retry_of)
      SELECT deploy_run_id, chat_session_id, ${ctx.actorId}::uuid, 'queued', classification,
             target_page_ids, performance_runs, fix_round, staged_by, id
      FROM quality_audit_runs WHERE id = ${prev.id}::uuid
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const auditRunId = inserted[0]?.id;
    if (!auditRunId) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.retry",
        message: "could not queue the retry",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.retry",
      input,
      succeeded: true,
      entityId: auditRunId,
      resultSummary: `retry of failed audit ${prev.id}`,
    });
    return ok({ auditRunId, status: "queued" as const });
  },
});

/** #727 — one group of open problems on the chat's card. */
const problemGroupSchema = z.object({
  key: z.string(),
  ref: z.union([
    z.object({ auditId: z.string() }),
    z.object({ category: categorySchema }),
    z.object({ ruleId: z.string() }),
  ]),
  title: z.string(),
  pages: z.array(
    z.object({ pageId: z.string().nullable(), pagePath: z.string(), detail: z.string() }),
  ),
});

const feedbackSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("note"), text: z.string() }),
    // #685 — shown as a card; `prompt` is sent only on the operator's click,
    // or on its own when `autoContinue` (#771: the next round of a fix-all).
    z.object({
      kind: z.literal("offer"),
      text: z.string(),
      actionLabel: z.string(),
      prompt: z.string(),
      groups: z.array(problemGroupSchema),
      autoContinue: z.boolean(),
    }),
  ])
  .nullable();

/** #727 — the groups / pages a "fix" click on the card covers. */
export const fixSelectionSchema = z
  .array(
    z
      .object({
        key: z.string().min(1).max(300),
        pagePaths: z.array(z.string().min(1).max(500)).min(1).max(20000).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(100);

export const chatStatusOp = defineOperation({
  name: "quality_audits.chat_status",
  // Read-only; the chat panel polls it. Open to every actor (§11).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      /** #727 — the card's "fix" click on some groups / pages: the offer's
       *  `prompt` then covers only those (nothing selected = every group). */
      fixSelection: fixSelectionSchema.optional(),
    })
    .strict(),
  output: z.object({
    audit: runSummarySchema.nullable(),
    /** Whether the chat was already told about `audit`. */
    notified: z.boolean(),
    /** What the chat should be told about `audit` (null while running). */
    feedback: feedbackSchema,
    /** The site-wide Publish gate (the staged build may come from another chat). */
    deployRunId: z.string().nullable(),
    gate: gateSchema.nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS}, q.chat_notified_at
      FROM quality_audit_runs q
      WHERE q.chat_session_id = ${input.chatSessionId}::uuid
      ORDER BY q.created_at DESC LIMIT 1
    `)) as unknown as (RunDbRow & { chat_notified_at: string | Date | null })[];
    const staged = await latestSucceededRun(tx, "staging");
    const decision = staged ? await publishGateForRun(tx, staged.id) : null;
    const gate = gateView(staged?.id ?? null, decision);
    const row = rows[0];
    if (!row) return ok({ audit: null, notified: false, feedback: null, ...gate });
    const audit = toRunSummary(row);
    // Only the audit of the build staging serves NOW may drive the chat: a
    // chat whose Stage another chat has since replaced must not offer an
    // obsolete fix round (or claim Publish is available).
    // A retry of the same build's check by someone else replaces it too.
    const current =
      staged !== null && staged.id === audit.deployRunId && decision?.auditRunId === audit.id;
    // #727 — the card groups the problems the gate blocks on NOW: an
    // acceptance (or revoke) changes the groups at once.
    const open = current && decision ? decision.openProblems : [];
    const summary: ChatAuditSummary = {
      status: audit.status,
      fixRound: audit.fixRound,
      stagedBy: audit.stagedBy,
      errorCode: audit.errorCode,
      errorMessage: audit.errorMessage,
      skippedBecause: audit.classification.skipped,
      lighthouse: audit.classification.auditNeeded,
      groups: groupOpenProblems(open),
      fixChain:
        current && audit.status === "problems" && audit.stagedBy === "live_edit_ai"
          ? await fixChainOf(tx, audit.id, open)
          : null,
    };
    let feedback = chatFeedbackFor(summary);
    if (feedback?.kind === "offer" && input.fixSelection) {
      const prompt = fixPromptFor(summary, input.fixSelection);
      feedback = prompt === null ? null : { ...feedback, prompt };
    }
    return ok({
      audit,
      notified: row.chat_notified_at !== null,
      feedback: current ? feedback : null,
      ...gate,
    });
  },
});

/**
 * #771 — the distance before and after the fix round an audit checks, when
 * the operator asked the AI to fix ALL problems of the chat's previous
 * audit ("Fix all with AI"); null otherwise. The previous audit's problems
 * are counted under today's acceptances, like the current ones, so an
 * acceptance in between is not mistaken for the AI's progress.
 *
 * `spentMicrocents` is the chat's AI spend (every `ai_calls` row of the
 * chat, subagents included) since the chain began: the earliest fix
 * request of the unbroken run of fix-all audits before this one. The
 * offer stops continuing on its own past AUTO_FIX_COST_CAP_MICROCENTS.
 */
async function fixChainOf(
  tx: Tx,
  auditRunId: string,
  open: GateDecision["openProblems"],
): Promise<ChatAuditSummary["fixChain"]> {
  const rows = (await tx.execute(sql`
    SELECT prev.id::text AS id, prev.fix_requested_at
    FROM quality_audit_runs cur
    JOIN LATERAL (
      SELECT id, status, fix_scope, fix_requested_at FROM quality_audit_runs p
      WHERE p.chat_session_id = cur.chat_session_id AND p.created_at < cur.created_at
      ORDER BY p.created_at DESC LIMIT 1
    ) prev ON TRUE
    WHERE cur.id = ${auditRunId}::uuid AND prev.status = 'problems' AND prev.fix_scope = 'all'
  `)) as unknown as { id: string; fix_requested_at: string | Date }[];
  const prevRow = rows[0];
  if (prevRow === undefined) return null;
  const prev = await loadGateAuditById(tx, prevRow.id);
  const pageIds = prev?.pages.map((p) => p.pageId) ?? [];
  const acceptances = await loadAcceptances(tx, pageIds);
  return {
    before: fixDistance(decideGate(prev, acceptances).openProblems),
    now: fixDistance(open),
    spentMicrocents: await fixChainSpend(tx, auditRunId),
    operatorDecided: await decidedSince(tx, pageIds, prevRow.fix_requested_at),
  };
}

/**
 * #685 — whether an editor accepted or revoked a quality decision on these
 * pages (or a site-wide check) after `since`: the "Fix all with AI" request
 * of the round now settling. Acceptances only apply on an editor's click
 * (`quality_audits.execute_proposal` / `quality_acceptances.revoke_many` are
 * human-only), so a decision in that window means the operator took over:
 * the next round waits for their click instead of continuing on its own.
 */
async function decidedSince(
  tx: Tx,
  pageIds: readonly string[],
  since: string | Date,
): Promise<boolean> {
  const at = since instanceof Date ? since.toISOString() : since;
  const rows = (await tx.execute(sql`
    SELECT 1 AS decided FROM quality_acceptances
    WHERE (page_id = ANY(${uuidList(pageIds)}) OR page_id IS NULL)
      AND (accepted_at >= ${at}::timestamptz OR revoked_at >= ${at}::timestamptz)
    LIMIT 1
  `)) as unknown as { decided: number }[];
  return rows.length > 0;
}

/** The chat's AI spend since the fix-all chain that led to `auditRunId`
 *  began (see fixChainOf). */
async function fixChainSpend(tx: Tx, auditRunId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    WITH cur AS (
      SELECT chat_session_id, created_at FROM quality_audit_runs WHERE id = ${auditRunId}::uuid
    ),
    earlier AS (
      SELECT p.status, p.fix_scope, p.fix_requested_at,
             row_number() OVER (ORDER BY p.created_at DESC) AS rn
      FROM quality_audit_runs p, cur
      WHERE p.chat_session_id = cur.chat_session_id AND p.created_at < cur.created_at
    ),
    chain_start AS (
      SELECT min(fix_requested_at) AS at FROM earlier
      WHERE rn < COALESCE(
        (SELECT min(rn) FROM earlier
         WHERE NOT (status = 'problems' AND fix_scope IS NOT DISTINCT FROM 'all')),
        9223372036854775807
      )
    )
    SELECT COALESCE(sum(a.cost_estimate_microcents), 0)::text AS spent
    FROM ai_calls a, cur, chain_start
    WHERE a.chat_session_id = cur.chat_session_id AND a.created_at >= chain_start.at
  `)) as unknown as { spent: string }[];
  const row = rows[0];
  // An aggregate without GROUP BY always yields one row.
  if (!row) throw new Error(`quality_audits.chat_status: no spend row for audit ${auditRunId}`);
  return Number(row.spent);
}

/** How long a chat tab may hold the delivery of an audit's message
 *  before another poll may deliver it instead. */
const NOTIFY_LEASE_SECONDS = 120;

export const claimChatNotificationOp = defineOperation({
  name: "quality_audits.claim_chat_notification",
  // Why human-only: the chat panel of the operator claims the message it is
  // about to deliver; a claim from anywhere else would swallow it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      auditRunId: z.string().uuid(),
      /** A status note to append to the chat in the SAME transaction, which
       *  then also marks the audit notified (delivery and claim are one). */
      note: z
        .object({ chatSessionId: z.string().uuid(), text: z.string().min(1).max(2000) })
        .strict()
        .optional(),
      /** #685 — the operator clicked "Fix with AI": record the requested
       *  fix round now, BEFORE the turn runs — the AI re-stages inside that
       *  turn, and the next audit's fix round is decided at that Stage.
       *  #771: `all` (every open group) lets the next round continue on its
       *  own; `picked` (some groups / pages) never does. */
      fixScope: z.enum(["all", "picked"]).nullable().default(null),
    })
    .strict()
    .refine((v) => !(v.fixScope !== null && v.note), {
      message: "a fix request starts a turn; a note settles the offer — pass one, not both",
    }),
  output: z.object({ claimed: z.boolean() }),
  handler: async (ctx, input, tx) => {
    // Any other claim (a note, "Not now") clears a fix request an earlier
    // click left behind when its tab closed before the turn ran.
    // A lease, not a final mark: a fix request (#685: sent only on the
    // operator's "Fix with AI") is delivered by the browser after this
    // call; only its acknowledgement (ack_chat_notification) marks the
    // audit notified. A tab that closes or a send that fails lets the
    // lease run out and the card offers the fix again.
    const rows = (await tx.execute(sql`
      UPDATE quality_audit_runs
         SET chat_notify_claimed_at = now(),
             fix_requested_at = CASE WHEN ${input.fixScope}::text IS NULL THEN NULL ELSE now() END,
             fix_scope = ${input.fixScope}
      WHERE id = ${input.auditRunId}::uuid AND chat_notified_at IS NULL
        AND status IN ('passed', 'problems', 'errored', 'skipped')
        AND (chat_notify_claimed_at IS NULL
             OR chat_notify_claimed_at < now() - make_interval(secs => ${NOTIFY_LEASE_SECONDS}))
      RETURNING id
    `)) as unknown as { id: string }[];
    if (rows.length !== 1) return ok({ claimed: false });
    // #771 — a fix-all request may run several AI rounds on its own: the
    // request that starts (or continues) that spend is on the record.
    if (input.fixScope !== null) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "quality_audits.claim_chat_notification",
        input,
        succeeded: true,
        entityId: input.auditRunId,
        resultSummary: `fix requested (${input.fixScope})`,
      });
    }
    if (input.note) {
      const appended = await appendChatMessageOp.handler(
        ctx,
        {
          chatSessionId: input.note.chatSessionId,
          role: "user",
          origin: "system",
          content: input.note.text,
          source: "quality-audit status note",
        },
        tx,
      );
      if (!appended.ok) throw new OperationAbortError(appended.error);
      await tx.execute(sql`
        UPDATE quality_audit_runs SET chat_notified_at = now() WHERE id = ${input.auditRunId}::uuid
      `);
    }
    return ok({ claimed: true });
  },
});

export const ackChatNotificationOp = defineOperation({
  name: "quality_audits.ack_chat_notification",
  // Why human-only: the chat panel acknowledges the fix request the
  // operator's click has just sent (persisted by the chat stream) — see claim_chat_notification.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ auditRunId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE quality_audit_runs SET chat_notified_at = now()
      WHERE id = ${input.auditRunId}::uuid AND chat_notified_at IS NULL
    `);
    return ok({});
  },
});

export const releaseChatNotificationOp = defineOperation({
  name: "quality_audits.release_chat_notification",
  // Why human-only: the chat panel gives back the claim of a fix request
  // the operator clicked that did NOT start a turn (an external agent works
  // in the chat, #682, or the send failed), so the card can be clicked again
  // at once instead of after the lease ran out — and no fix round counts.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ auditRunId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE quality_audit_runs
         SET chat_notify_claimed_at = NULL, fix_requested_at = NULL, fix_scope = NULL
      WHERE id = ${input.auditRunId}::uuid AND chat_notified_at IS NULL
    `);
    return ok({});
  },
});

const publishAnywayInput = z
  .object({
    auditRunId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
    fromTarget: z.string().min(1).default("staging"),
    toTarget: z.string().min(1).default("production"),
    /**
     * The Publish live run's id, minted by an approval card that claims its
     * proposal first (quality_audits.execute_proposal). Default: a fresh id.
     */
    runId: z.string().uuid().optional(),
  })
  .strict();

export const checkPublishAnywayOp = defineOperation({
  name: "quality_audits.check_publish_anyway",
  // Why human-only: the first step of quality_audits.publish_anyway (a
  // human's decision, #553); it writes nothing and no AI tool wraps it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: publishAnywayInput,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    if (!(await actorHasPermission(tx, ctx, "deploy.trigger"))) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.publish_anyway",
        message:
          "publishing needs the deploy.trigger permission — ask an editor who may publish to decide",
      });
    }
    const run = await latestSucceededRun(tx, input.fromTarget);
    const gate = run ? await publishGateForRun(tx, run.id) : null;
    if (!gate || gate.auditRunId !== input.auditRunId || gate.state !== "errored") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.publish_anyway",
        message: !gate
          ? `nothing staged on '${input.fromTarget}' — Stage first`
          : gate.state === "errored"
            ? `audit ${input.auditRunId} is not the failed check of the current staged build (that is ${gate.auditRunId}) — call quality_audits.gate_status for the current one`
            : `publish anyway only applies to a FAILED quality check; the staged build's check is '${gate.state}'. ${gate.message}`,
      });
    }
    return ok({});
  },
});

/**
 * #553 — publish over a FAILED quality check (a human's decision).
 * #1225 — step-wise: the decision is checked in one short step, then
 * Publish live runs as its own op (no transaction across its rebuild and
 * upload) carrying the decision. Publish live records the override and its
 * audit event in the transaction that records its run as succeeded, so a
 * publish that fails leaves neither behind and the decision can be made
 * again (an approval card stays retryable).
 */
export const publishAnywayOp = defineStepwiseOperation({
  name: "quality_audits.publish_anyway",
  // Why human-only: this IS the human decision the gate exists to obtain
  // (#553: never the AI on its own). The AI reaches it only through the
  // approval card of publish_despite_failed_audit, applied as the human.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: publishAnywayInput,
  output: z.object({ fromRunId: z.string(), toRunId: z.string(), buildId: z.string() }),
  stepwise: async (ctx, input, steps) => {
    const checked = await execute(
      steps.registry,
      steps.adapter,
      ctx,
      "quality_audits.check_publish_anyway",
      input,
    );
    if (!checked.ok) return err(checked.error);
    const promoted = await execute(
      steps.registry,
      steps.adapter,
      ctx,
      "deploy.promote",
      {
        fromTarget: input.fromTarget,
        toTarget: input.toTarget,
        ...(input.runId ? { runId: input.runId } : {}),
        publishAnyway: { auditRunId: input.auditRunId, reason: input.reason },
      },
      steps.signal ? { signal: steps.signal } : {},
    );
    if (!promoted.ok) return err(promoted.error);
    return ok(promoted.value as { fromRunId: string; toRunId: string; buildId: string });
  },
});
