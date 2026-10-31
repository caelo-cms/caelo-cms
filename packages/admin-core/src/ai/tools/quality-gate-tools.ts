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
import { describeError, toolError } from "./_describe-error.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { AUDIT_PENDING_NEXT_STEP } from "./quality-audit-tools.js";

const noInput = z.object({}).strict();

export const getPublishGateTool = makeReadTool<Record<string, never>>({
  name: "get_publish_gate",
  description:
    "Is Publish live open for the staged build? If not: why + next step (fix quality problems — target 100, zero findings — or hand truly unfixable ones to the operator as a decision; retry a failed check; wait for a running one). Call before telling the operator they can publish. Findings -> `get_quality_audit`.",
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
    "Re-run the staged build's quality check when it FAILED (browser, timeout, staging unreachable) or never ran; changes nothing. Not for re-checking fixes — those need a new Stage, which audits itself.",
  schema: noInput,
  inputSchema: z.toJSONSchema(noInput) as Record<string, unknown>,
  handler: async (ctx, _input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "quality_audits.retry", {});
    if (!r.ok) {
      return toolError(r.error, `quality_audits.retry failed: ${describeError(r.error)}`);
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
    'Hand the operator a decision on quality findings that truly CANNOT be fixed, or record an acceptance they explicitly asked for ("accept it", "ship it anyway").\n' +
    "CORE RULES:\n" +
    "- Target = 100 per Lighthouse category + zero findings; 90 is NOT acceptable on its own. Fix what is fixable (metrics: `get_quality_audit`; never run Lighthouse yourself).\n" +
    "- On your own only after explaining WHY it cannot be fixed (third-party embed, brand colour the operator confirmed, Caelo platform issue reported via `bug_report`); phrase it as the operator's choice, never your recommendation.\n" +
    "- Check `list_quality_acceptances` first; never ask twice. Every group of one decision -> ONE call.\n" +
    "- Accepts the value measured now (score, audit score, error count): worse blocks again, better tightens it. Applies ONLY to its pages.\n" +
    "- Once approved it counts at once — Publish live opens without a new Stage. Do NOT call `stage_changes` to 'pick it up': a Stage with nothing new re-runs the whole check and can start another fix round.",
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
  when: "Publish the staged build live although its quality check FAILED to run (not when it found problems), recording the editor's reason. ONLY on the editor's explicit request, after `retry_quality_audit`. auditRunId: `get_publish_gate`.",
  schema: proposePublishAnywayInput,
  inputSchema: z.toJSONSchema(proposePublishAnywayInput) as Record<string, unknown>,
  summarize: (input) => `publish over the failed quality check: ${input.reason}`,
});
