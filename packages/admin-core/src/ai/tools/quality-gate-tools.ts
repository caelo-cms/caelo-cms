// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the AI's tools around the Publish-live quality gate.
 *
 *   get_publish_gate              may the staged build go live? (read)
 *   retry_quality_audit           re-run a failed / missing check (routine)
 *   accept_quality_findings       APPROVAL-GATED: an editor accepts findings
 *                                 or scores below 100 on pages — bulk per
 *                                 group of one problem across pages (#727)
 *   publish_despite_failed_audit  APPROVAL-GATED: an editor publishes over a
 *                                 FAILED check, with a recorded reason
 *
 * The two gated tools ride the SDK tool approval (§11.A): the turn pauses on
 * an in-chat Approve/Reject card and only the human's click applies them.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { proposeAcceptInput, proposePublishAnywayInput } from "../../ops/quality/pending.js";
import { describeError } from "./_describe-error.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { AUDIT_PENDING_NEXT_STEP } from "./quality-audit-tools.js";

const noInput = z.object({}).strict();

export const getPublishGateTool = makeReadTool<Record<string, never>>({
  name: "get_publish_gate",
  description:
    "Check whether Publish live is open for the current staged build, and if not why and what to do next (quality problems to fix — the target is 100 and zero findings — or, if truly unfixable, to hand to the operator as a decision; a failed check to retry; a check still running). " +
    "Call before telling the operator they can publish. For the findings themselves use get_quality_audit.",
  opName: "quality_audits.gate_status",
  input: noInput,
  buildOpInput: () => ({}),
  format: (value) => {
    const v = value as {
      deployRunId: string | null;
      gate: { open: boolean; state: string; message: string; auditRunId: string | null } | null;
    };
    if (!v.deployRunId || !v.gate) return "Nothing is staged yet — Stage first.";
    if (v.gate.open) {
      return `Publish live is open (${v.gate.state}).${v.gate.message ? ` ${v.gate.message}` : ""}`;
    }
    const pending = v.gate.state === "running" || v.gate.state === "queued";
    return `Publish live is BLOCKED (${v.gate.state}, audit ${v.gate.auditRunId ?? "none"}): ${v.gate.message}${pending ? ` ${AUDIT_PENDING_NEXT_STEP}` : ""}`;
  },
});

export const retryQualityAuditTool: ToolDefinitionWithHandler<Record<string, never>> = {
  name: "retry_quality_audit",
  description:
    "Re-run the quality check of the current staged build when it FAILED (browser, timeout, staging unreachable) or never ran. It changes nothing on the site. " +
    "Do not use it to re-check after fixes — fixes reach staging only through a new Stage, which audits by itself.",
  schema: noInput,
  inputSchema: z.toJSONSchema(noInput) as Record<string, unknown>,
  handler: async (ctx, _input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "quality_audits.retry", {});
    if (!r.ok) {
      return { ok: false, content: `quality_audits.retry failed: ${describeError(r.error)}` };
    }
    const v = r.value as { auditRunId: string; status: string };
    return {
      ok: true,
      content:
        v.status === "queued"
          ? `Quality check ${v.auditRunId} queued; it takes 2–4 minutes. Read the result with get_quality_audit.`
          : `No quality check needed for the staged build (audit ${v.auditRunId} skipped).`,
      value: v,
    };
  },
};

type AcceptInput = z.infer<typeof proposeAcceptInput>;

export const acceptQualityFindingsTool = makeProposeTool<AcceptInput>({
  toolName: "accept_quality_findings",
  opName: "quality_audits.propose_accept",
  pendingQueuePath: "/settings/quality/pending",
  // #667 — the AI never argues for an acceptance (the dogfood run had it
  // say "I'd accept all four", two of them Caelo bugs). #727 "optimum, not
  // good enough" — what truly cannot be fixed goes to the operator as ONE
  // decision per group of findings; the operator approves or rejects it.
  when:
    'Hand the operator a decision on quality findings that truly CANNOT be fixed, or record the acceptance the operator explicitly asked for ("accept it", "leave the contrast as it is", "ship it anyway"). ' +
    "The target is 100 in every Lighthouse category and zero findings: a score like 90 is NOT acceptable on its own, and anything you can still fix you fix (read the metrics in get_quality_audit; never run Lighthouse yourself). " +
    "Use it on your own only after explaining WHY a finding cannot be fixed (a third-party embed, a brand colour the operator confirmed, a Caelo platform issue you reported with bug_report), and phrase it as the operator's choice, never as your recommendation. " +
    'BULK: prefer `groups` — one problem across pages in one entry (`{ ruleId: "seo-check/description-missing" }` = every page it is open on; add `pagePaths` for a subset; a Lighthouse audit by `auditId`, a category below 100 by `category`). Use `items` only for single findings on named pages. Bundle every group of one decision into ONE call. ' +
    "What is accepted is the value measured now (score, audit score, error count): a worse value blocks again, a better one tightens the acceptance. An acceptance applies ONLY to its pages. Check list_quality_acceptances first; never ask twice. " +
    "Take auditRunId, page paths and audit / rule ids from get_quality_audit; the reason is the operator's or the plain fact why it cannot be fixed. " +
    "Once approved, an acceptance counts at once — Publish live opens without a new Stage. Do NOT call stage_changes afterwards just to 'pick up' the acceptance: a Stage with nothing new still re-runs the whole quality check, which can report fresh findings and start another fix round.",
  schema: proposeAcceptInput,
  inputSchema: z.toJSONSchema(proposeAcceptInput) as Record<string, unknown>,
  summarize: (input, preview) =>
    `accept ${String(preview.acceptanceCount ?? input.items?.length ?? 0)} quality finding(s) (${input.groups?.length ?? 0} group(s), ${input.items?.length ?? 0} single): ${input.reason}`,
});

type PublishAnywayInput = z.infer<typeof proposePublishAnywayInput>;

export const publishDespiteFailedAuditTool = makeProposeTool<PublishAnywayInput>({
  toolName: "publish_despite_failed_audit",
  opName: "quality_audits.propose_publish_anyway",
  pendingQueuePath: "/settings/quality/pending",
  when:
    "Only when the editor explicitly wants to publish although the quality check FAILED to run (no result — not when it found problems): publishes the staged build live and records the editor's reason. " +
    "Try retry_quality_audit first. Take auditRunId from get_publish_gate.",
  schema: proposePublishAnywayInput,
  inputSchema: z.toJSONSchema(proposePublishAnywayInput) as Record<string, unknown>,
  summarize: (input) => `publish over the failed quality check: ${input.reason}`,
});
