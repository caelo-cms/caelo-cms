// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the human-confirmed quality decisions, on the standard
 * propose/execute engine (CLAUDE.md §11.A) behind the in-chat approval
 * cards:
 *
 *   quality_audits.propose_accept          accept findings / scores below
 *                                          100 on pages — single items or
 *                                          #727 bulk groups (one problem
 *                                          across many pages, one click).
 *                                          Any editor may approve.
 *   quality_audits.propose_publish_anyway  publish over a FAILED audit.
 *   quality_audits.execute_proposal        apply — human/system only.
 *   quality_audits.reject_proposal / list_pending.
 *
 * The AI can propose but never apply: the SDK pauses on the approval card,
 * and only the human's click runs execute_proposal (as that human, who is
 * then recorded as `accepted_by` / `publish_override_by`).
 */

import { defineOperation, type QueryError } from "@caelo-cms/query-api";
import { err, ok, type ProposalStatus, proposalStatus, type Result } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { ruleIdSchema } from "../../quality/checks/findings.js";
import { decideGate, SITE_WIDE_PATH } from "../../quality/gate.js";
import { auditScorePoints, type QualityProblem } from "../../quality/ratchet.js";
import { jsonbParam } from "../../sql-helpers.js";
import { requiresApproverPermission } from "../_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { actorHasPermission } from "./_permissions.js";
import { categorySchema, iso } from "./_shared.js";
import { publishAnywayOp } from "./gate.js";
import {
  latestSucceededRun,
  loadAcceptances,
  loadGateAuditById,
  publishGateForRun,
} from "./gate-loader.js";

/**
 * The audit the gate currently decides on (the newest audit of the build
 * staging serves). Acceptances only make sense against it: accepting from
 * an older audit would record values a newer audit no longer measures.
 */
async function currentGateAuditId(tx: Tx): Promise<string | null> {
  const run = await latestSucceededRun(tx, "staging");
  if (!run) return null;
  return (await publishGateForRun(tx, run.id)).auditRunId;
}

function staleAuditMessage(auditRunId: string, current: string | null): string {
  return current
    ? `audit ${auditRunId} is not the current quality check of the staged build (that is ${current}) — call get_quality_audit and accept from the current one`
    : "nothing is staged — Stage first";
}

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** One thing to accept, named by the page's path so the editor reads it
 *  on the approval card as-is ("/about: image-alt"). */
const acceptItemSchema = z.union([
  z.object({ pagePath: z.string().min(1).max(500), auditId: z.string().min(1).max(200) }).strict(),
  z.object({ pagePath: z.string().min(1).max(500), category: categorySchema }).strict(),
  // #727 — a page-check rule over its accepted count: every error of the
  // rule measured now is accepted on that page; omit pagePath for a
  // site-wide finding.
  z.object({ pagePath: z.string().min(1).max(500).optional(), ruleId: ruleIdSchema }).strict(),
]);

/** Pages of a group: omitted = every page the group is open on. */
const groupPagesSchema = z.array(z.string().min(1).max(500)).min(1).max(20000).optional();

/**
 * #727 — a BULK decision: one problem across pages ("seo-check/
 * description-missing on 312 pages"), named by what failed. Every page the
 * problem is open on in the current audit, or only `pagePaths` ("site-wide"
 * for a site-wide page-check finding).
 */
const acceptGroupSchema = z.union([
  z.object({ auditId: z.string().min(1).max(200), pagePaths: groupPagesSchema }).strict(),
  z.object({ category: categorySchema, pagePaths: groupPagesSchema }).strict(),
  z.object({ ruleId: ruleIdSchema, pagePaths: groupPagesSchema }).strict(),
]);

export const proposeAcceptInput = z
  .object({
    /** The audit the findings come from (get_quality_audit shows its id). */
    auditRunId: z
      .string()
      .uuid()
      .describe("From `get_quality_audit` (as are page paths and audit/rule ids)."),
    /** Single findings (Lighthouse audit id), category scores below 100
     *  (category) or page-check rules (rule id) on named pages. */
    items: z
      .array(acceptItemSchema)
      .min(1)
      .max(50)
      .optional()
      .describe("Only for single findings on named pages."),
    /** Bulk: one problem on every page it is open on (or the listed ones). */
    groups: z
      .array(acceptGroupSchema)
      .min(1)
      .max(50)
      .optional()
      .describe(
        'PREFERRED: one problem across pages per entry. `{ruleId:"seo-check/description-missing"}` = every page it is open on; `pagePaths` = subset; Lighthouse audit by `auditId`, category below 100 by `category`.',
      ),
    /** Why these are acceptable — shown to the editor and stored. */
    reason: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe("The operator's reason, or the plain fact why it cannot be fixed."),
  })
  .strict()
  .refine((v) => (v.items?.length ?? 0) + (v.groups?.length ?? 0) > 0, {
    message: "name at least one finding: `items` (per page) or `groups` (one problem across pages)",
  });

type ProposeAcceptInput = z.infer<typeof proposeAcceptInput>;

interface ResolvedItem {
  /** Null only for a site-wide page-check rule. */
  readonly pageId: string | null;
  readonly pagePath: string;
  readonly kind: "finding" | "score" | "check";
  /** The Lighthouse audit id, or the page-check rule id. */
  readonly auditId: string | null;
  readonly category: string | null;
  /** The accepted value in points: a category score, or a Lighthouse
   *  audit's score × 100. A worse measurement blocks again. */
  readonly score: number | null;
  /** For a page-check rule: the error count that becomes accepted. */
  readonly count: number | null;
  readonly label: string;
}

function problemName(x: QualityProblem): string {
  switch (x.kind) {
    case "failing_audit":
      return x.auditId;
    case "score_below_baseline":
      return `${x.category} score`;
    case "check_rule":
      return x.ruleId;
  }
}

/** The acceptance of one recorded problem on one page (or site-wide). */
function resolvedFromProblem(
  pageId: string | null,
  pagePath: string,
  p: QualityProblem,
): ResolvedItem {
  switch (p.kind) {
    case "check_rule":
      return {
        pageId,
        pagePath,
        kind: "check",
        auditId: p.ruleId,
        category: null,
        score: null,
        count: p.count,
        label: `${pagePath}: ${p.ruleId} — ${p.count} error(s) accepted (a new one blocks again)`,
      };
    case "failing_audit": {
      const points = auditScorePoints(p.score);
      return {
        pageId,
        pagePath,
        kind: "finding",
        auditId: p.auditId,
        category: null,
        score: points,
        count: null,
        label: `${pagePath}: ${p.auditId} — ${p.title} (score ${points}; a worse score blocks again)`,
      };
    }
    case "score_below_baseline":
      return {
        pageId,
        pagePath,
        kind: "score",
        auditId: null,
        category: p.category,
        score: p.score,
        count: null,
        label: `${pagePath}: ${p.category} score ${p.score} accepted (target 100; a lower score blocks again)`,
      };
  }
}

function resolveCheckItem(
  pageId: string | null,
  pagePath: string,
  problems: readonly QualityProblem[],
  ruleId: string,
): ResolvedItem | { message: string } {
  const p = problems.find((x) => x.kind === "check_rule" && x.ruleId === ruleId);
  if (p?.kind !== "check_rule") {
    return {
      message: `'${ruleId}' is not a problem ${pageId === null ? "site-wide" : `on ${pagePath}`} in this audit — its problems: ${problems.map(problemName).join(", ") || "none"}`,
    };
  }
  return resolvedFromProblem(pageId, pagePath, p);
}

/**
 * Check every item against the audit's recorded problems: only a real,
 * current problem can be accepted (an AI typo must not mint an
 * acceptance for something that never failed).
 */
async function resolveItems(
  tx: Tx,
  input: ProposeAcceptInput,
): Promise<{ ok: true; items: ResolvedItem[]; lines: string[] } | { ok: false; message: string }> {
  const rows = (await tx.execute(sql`
    SELECT qp.page_id::text AS page_id, p.current_path, qp.problems
    FROM quality_audit_pages qp JOIN pages p ON p.id = qp.page_id AND p.deleted_at IS NULL
    WHERE qp.audit_run_id = ${input.auditRunId}::uuid
  `)) as unknown as { page_id: string; current_path: string; problems: unknown }[];
  const siteRows = (await tx.execute(sql`
    SELECT COALESCE(checks->'siteProblems', '[]'::jsonb) AS site_problems
    FROM quality_audit_runs WHERE id = ${input.auditRunId}::uuid
  `)) as unknown as { site_problems: unknown }[];
  const siteProblems = (siteRows[0]?.site_problems ?? []) as QualityProblem[];
  if (rows.length === 0 && siteProblems.length === 0) {
    return {
      ok: false,
      message: `audit ${input.auditRunId} has no audited pages — call get_quality_audit for the current audit id`,
    };
  }
  const byPath = new Map(rows.map((r) => [r.current_path, r]));
  const resolved: ResolvedItem[] = [];
  for (const item of input.items ?? []) {
    if ("ruleId" in item && item.pagePath === undefined) {
      const r = resolveCheckItem(null, SITE_WIDE_PATH, siteProblems, item.ruleId);
      if ("message" in r) return { ok: false, message: r.message };
      resolved.push(r);
      continue;
    }
    const pagePath = item.pagePath as string;
    const page = byPath.get(pagePath);
    if (!page) {
      return {
        ok: false,
        message: `${pagePath} has no findings in ${input.auditRunId} — pages with findings: ${rows.map((r) => r.current_path).join(", ") || "none"}${siteProblems.length > 0 ? " (site-wide findings: omit pagePath)" : ""}`,
      };
    }
    const problems = page.problems as QualityProblem[];
    if ("ruleId" in item) {
      const r = resolveCheckItem(page.page_id, page.current_path, problems, item.ruleId);
      if ("message" in r) return { ok: false, message: r.message };
      resolved.push(r);
    } else if ("auditId" in item) {
      const p = problems.find((x) => x.kind === "failing_audit" && x.auditId === item.auditId);
      if (p?.kind !== "failing_audit") {
        return {
          ok: false,
          message: `'${item.auditId}' is not a problem on ${page.current_path} in this audit — its problems: ${problems.map(problemName).join(", ") || "none"}`,
        };
      }
      resolved.push(resolvedFromProblem(page.page_id, page.current_path, p));
    } else {
      const p = problems.find(
        (x) => x.kind === "score_below_baseline" && x.category === item.category,
      );
      if (p?.kind !== "score_below_baseline") {
        return {
          ok: false,
          message: `the ${item.category} score is not below 100 on ${page.current_path} in this audit — nothing to accept`,
        };
      }
      resolved.push(resolvedFromProblem(page.page_id, page.current_path, p));
    }
  }
  const lines = resolved.map((i) => i.label);
  for (const group of input.groups ?? []) {
    const r = await resolveGroup(tx, input.auditRunId, group);
    if (!r.ok) return r;
    resolved.push(...r.items);
    const sample = r.items.slice(0, 5).map((i) => i.pagePath);
    const more = r.items.length > 5 ? `, +${r.items.length - 5} more` : "";
    lines.push(`${groupName(group)} on ${r.items.length} page(s): ${sample.join(", ")}${more}`);
  }
  return { ok: true, items: dedupeItems(resolved), lines };
}

/** One acceptance per page + kind + id: an item and a group naming the
 *  same finding accept it once. */
function dedupeItems(items: readonly ResolvedItem[]): ResolvedItem[] {
  const seen = new Map<string, ResolvedItem>();
  for (const i of items) {
    seen.set(`${i.pageId ?? "site"}|${i.kind}|${i.auditId ?? i.category ?? ""}`, i);
  }
  return [...seen.values()];
}

type AcceptGroup = NonNullable<ProposeAcceptInput["groups"]>[number];

function groupMatches(group: AcceptGroup, p: QualityProblem): boolean {
  if ("ruleId" in group) return p.kind === "check_rule" && p.ruleId === group.ruleId;
  if ("auditId" in group) return p.kind === "failing_audit" && p.auditId === group.auditId;
  return p.kind === "score_below_baseline" && p.category === group.category;
}

function groupName(group: AcceptGroup): string {
  if ("ruleId" in group) return group.ruleId;
  if ("auditId" in group) return group.auditId;
  return `${group.category} score`;
}

/**
 * #727 — resolve a bulk group against the OPEN problems of the audit (what
 * the gate blocks on now): already-accepted pages are not accepted twice,
 * and a page the operator picked that is not open is an error, not a
 * silent skip.
 */
async function resolveGroup(
  tx: Tx,
  auditRunId: string,
  group: AcceptGroup,
): Promise<{ ok: true; items: ResolvedItem[] } | { ok: false; message: string }> {
  const audit = await loadGateAuditById(tx, auditRunId);
  if (!audit) return { ok: false, message: `audit ${auditRunId} not found` };
  const acceptances = await loadAcceptances(
    tx,
    audit.pages.map((p) => p.pageId),
  );
  const open = decideGate(audit, acceptances).openProblems.filter((o) =>
    groupMatches(group, o.problem),
  );
  if (open.length === 0) {
    return {
      ok: false,
      message: `'${groupName(group)}' is not open on any page in audit ${auditRunId} — it is fixed or already accepted. get_quality_audit lists what is open.`,
    };
  }
  const picked = group.pagePaths ? new Set(group.pagePaths) : null;
  if (picked) {
    const openPaths = new Set(open.map((o) => o.pagePath));
    const unknown = [...picked].filter((path) => !openPaths.has(path));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `'${groupName(group)}' is not open on ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""} — it is open on ${open.length} page(s): ${open
          .slice(0, 10)
          .map((o) => o.pagePath)
          .join(", ")}${open.length > 10 ? ", …" : ""}`,
      };
    }
  }
  return {
    ok: true,
    items: open
      .filter((o) => picked === null || picked.has(o.pagePath))
      .map((o) => resolvedFromProblem(o.pageId, o.pagePath, o.problem)),
  };
}

async function queueProposal(
  tx: Tx,
  ctx: { actorId: string; requestId: string; chatBranchId?: string; chatTaskId?: string },
  kind: "accept" | "publish_anyway",
  auditRunId: string,
  payload: unknown,
  preview: Record<string, unknown>,
  opName: string,
): Promise<Result<{ proposalId: string; preview: Record<string, unknown> }, QueryError>> {
  const payloadHash = await hashProposalPayload({ kind, payload });
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO quality_pending_actions
        (kind, proposed_by, audit_run_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (${kind}, ${ctx.actorId}::uuid, ${auditRunId}::uuid, ${jsonbParam(payload)},
              ${jsonbParam(preview)}, 'pending',
              ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`}, ${payloadHash})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
  } catch (e) {
    if (isDuplicatePendingError(e)) {
      return err({ kind: "HandlerError", operation: opName, message: DUPLICATE_PROPOSAL_MESSAGE });
    }
    throw e;
  }
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return err({ kind: "HandlerError", operation: opName, message: "insert returned no id" });
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: payload,
    succeeded: true,
    entityId: proposalId,
    resultSummary: `kind=${kind}`,
  });
  return ok({ proposalId, preview });
}

const proposeOutput = z.object({
  proposalId: z.string(),
  preview: z.record(z.string(), z.unknown()),
});

export const proposeAcceptOp = defineOperation({
  name: "quality_audits.propose_accept",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeAcceptInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const current = await currentGateAuditId(tx);
    if (current !== input.auditRunId) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.propose_accept",
        message: staleAuditMessage(input.auditRunId, current),
      });
    }
    const r = await resolveItems(tx, input);
    if (!r.ok) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.propose_accept",
        message: r.message,
      });
    }
    const preview = {
      kind: "accept",
      reason: input.reason,
      accepts: r.lines,
      acceptanceCount: r.items.length,
      note: "Applies only to these pages; the same finding on another page still blocks. A worse value than accepted blocks again; every acceptance stays listed (and revocable) under Settings → Quality.",
    };
    return queueProposal(
      tx,
      ctx,
      "accept",
      input.auditRunId,
      input,
      preview,
      "quality_audits.propose_accept",
    );
  },
});

export const proposePublishAnywayInput = z
  .object({
    /** The FAILED audit of the staged build (quality_audits.gate_status). */
    auditRunId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const proposePublishAnywayOp = defineOperation({
  name: "quality_audits.propose_publish_anyway",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposePublishAnywayInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT status, error_code, error_message FROM quality_audit_runs
      WHERE id = ${input.auditRunId}::uuid
    `)) as unknown as { status: string; error_code: string | null; error_message: string | null }[];
    const run = rows[0];
    if (run?.status !== "errored") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.propose_publish_anyway",
        message: run
          ? `audit ${input.auditRunId} did not fail (it is '${run.status}'): publish anyway is only for a failed quality check — fix or accept problems instead`
          : `audit ${input.auditRunId} not found — call quality_audits.gate_status for the current one`,
      });
    }
    const preview = {
      kind: "publish_anyway",
      failedCheck: `${run.error_code ?? "error"}: ${run.error_message ?? ""}`,
      reason: input.reason,
      effect: "Publishes the staged build live now, without a quality result.",
    };
    return queueProposal(
      tx,
      ctx,
      "publish_anyway",
      input.auditRunId,
      input,
      preview,
      "quality_audits.propose_publish_anyway",
    );
  },
});

/**
 * Write the acceptances of a confirmed proposal as `ctx` (the human), in
 * one statement pair however many pages a bulk decision covers: the live
 * acceptance of each page + kind + id is revoked (kept as history) and
 * replaced by the new one with the value measured now.
 */
async function applyAcceptances(
  tx: Tx,
  ctx: { actorId: string },
  input: ProposeAcceptInput,
): Promise<{ ok: true; accepted: number } | { ok: false; message: string }> {
  // Re-resolve at apply time: the page may have been deleted, or the
  // audit superseded, between the card and the click.
  const r = await resolveItems(tx, input);
  if (!r.ok) return r;
  const rows = jsonbParam(
    r.items.map((i) => ({
      page_id: i.pageId,
      kind: i.kind,
      audit_id: i.auditId,
      category: i.category,
      score: i.score,
      count: i.count,
    })),
  );
  const recordset = sql`jsonb_to_recordset(${rows}) AS r(page_id uuid, kind text, audit_id text, category text, score integer, count integer)`;
  await tx.execute(sql`
    UPDATE quality_acceptances a
       SET revoked_at = now(), revoked_by = ${ctx.actorId}::uuid
      FROM ${recordset}
     WHERE a.revoked_at IS NULL AND a.kind = r.kind
       AND a.page_id IS NOT DISTINCT FROM r.page_id
       AND a.audit_id IS NOT DISTINCT FROM r.audit_id
       AND a.category IS NOT DISTINCT FROM r.category
  `);
  const inserted = (await tx.execute(sql`
    INSERT INTO quality_acceptances
      (page_id, kind, audit_id, category, accepted_score, accepted_count, reason, accepted_by,
       audit_run_id)
    SELECT r.page_id, r.kind, r.audit_id, r.category,
           CASE WHEN r.kind = 'check' THEN NULL ELSE r.score END,
           CASE WHEN r.kind = 'check' THEN r.count ELSE NULL END,
           ${input.reason}, ${ctx.actorId}::uuid, ${input.auditRunId}::uuid
      FROM ${recordset}
    RETURNING id
  `)) as unknown as { id: string }[];
  return { ok: true, accepted: inserted.length };
}

const executeQualityProposalOpDefinition = defineOperation({
  name: "quality_audits.execute_proposal",
  // Why human-only: the click the §11.A gate exists to obtain.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    kind: z.enum(["accept", "publish_anyway"]),
    accepted: z.number().int().optional(),
    toRunId: z.string().optional(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT kind, payload, status FROM quality_pending_actions
      WHERE id = ${input.proposalId}::uuid FOR UPDATE
    `)) as unknown as { kind: "accept" | "publish_anyway"; payload: unknown; status: string }[];
    const row = rows[0];
    if (row?.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.execute_proposal",
        message: row ? `proposal is already ${row.status}` : "proposal not found",
      });
    }
    // The approval card applies this op as the chat's operator without a
    // route in front, so the persisted kind decides the permission here.
    const needed = row.kind === "accept" ? "content.write" : "deploy.trigger";
    if (!(await actorHasPermission(tx, ctx, needed))) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.execute_proposal",
        message: `permission_denied: this decision needs the ${needed} permission — ask an editor who has it. The proposal stays pending.`,
      });
    }
    let result: { kind: "accept" | "publish_anyway"; accepted?: number; toRunId?: string };
    if (row.kind === "accept") {
      const payload = proposeAcceptInput.parse(row.payload);
      const current = await currentGateAuditId(tx);
      if (current !== payload.auditRunId) {
        await tx.execute(sql`
          UPDATE quality_pending_actions
             SET status = 'superseded', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
                 decision_reason = 'a newer quality check replaced the audit it was made for'
           WHERE id = ${input.proposalId}::uuid
        `);
        return err({
          kind: "HandlerError",
          operation: "quality_audits.execute_proposal",
          message: staleAuditMessage(payload.auditRunId, current),
        });
      }
      const applied = await applyAcceptances(tx, ctx, payload);
      if (!applied.ok) {
        return err({
          kind: "HandlerError",
          operation: "quality_audits.execute_proposal",
          message: applied.message,
        });
      }
      result = { kind: "accept", accepted: applied.accepted };
    } else {
      const payload = proposePublishAnywayInput.parse(row.payload);
      const published = await publishAnywayOp.handler(
        ctx,
        {
          auditRunId: payload.auditRunId,
          reason: payload.reason,
          fromTarget: "staging",
          toTarget: "production",
        },
        tx,
      );
      if (!published.ok) return published;
      result = { kind: "publish_anyway", toRunId: published.value.toRunId };
    }
    await tx.execute(sql`
      UPDATE quality_pending_actions
         SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
       WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary:
        result.kind === "accept"
          ? `accepted ${result.accepted} quality finding(s)`
          : `published anyway (run ${result.toRunId})`,
    });
    return ok(result);
  },
});

/**
 * #589 — every quality decision needs content.write (the panel's Approve
 * guard); publishing despite a failed audit additionally needs
 * deploy.trigger, which the handler checks per the row's kind.
 */
export const executeQualityProposalOp = requiresApproverPermission(
  ["content.write"],
  executeQualityProposalOpDefinition,
);

export const rejectQualityProposalOp = defineOperation({
  name: "quality_audits.reject_proposal",
  // Why human-only: rejecting is the human half of the §11.A decision.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({ proposalId: z.string().uuid(), reason: z.string().min(1).max(500).optional() })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE quality_pending_actions
         SET status = 'rejected', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
             decision_reason = ${input.reason ?? null}
       WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

export const listPendingQualityProposalsOp = defineOperation({
  name: "quality_audits.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({
    proposals: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["accept", "publish_anyway"]),
        proposedBy: z.string(),
        auditRunId: z.string().nullable(),
        preview: z.record(z.string(), z.unknown()),
        status: proposalStatus,
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, proposed_by::text AS proposed_by,
             audit_run_id::text AS audit_run_id, preview, status, created_at
      FROM quality_pending_actions WHERE status = 'pending'
      ORDER BY created_at DESC LIMIT ${input.limit ?? 50}
    `)) as unknown as {
      id: string;
      kind: "accept" | "publish_anyway";
      proposed_by: string;
      audit_run_id: string | null;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
    }[];
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        auditRunId: r.audit_run_id,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: iso(r.created_at),
      })),
    });
  },
});
