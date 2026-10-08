// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the AI's read surface of the quality gate (CLAUDE.md §11:
 * on-demand list_/get_ tools, no system-prompt context block).
 *
 *   get_quality_audit         the full findings of one audit: per page the
 *                             scores vs. baselines, every problem with its
 *                             Lighthouse audit id, held-back Performance
 *                             signals, and infrastructure errors.
 *   list_quality_audits       recent audit runs and how they ended.
 *   list_quality_acceptances  findings / score drops editors accepted, per
 *                             page — so the AI never asks twice.
 */

import { z } from "zod";
import type { getAuditOp, listAcceptancesOp, listAuditsOp } from "../../ops/quality/read.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";

type AuditValue = z.infer<(typeof getAuditOp)["output"]>;
type AuditRun = NonNullable<AuditValue["run"]>;
type AuditPage = AuditValue["pages"][number];
type AuditListRow = z.infer<(typeof listAuditsOp)["output"]>["runs"][number];
type AcceptanceRow = z.infer<(typeof listAcceptancesOp)["output"]>["acceptances"][number];

const getAuditInput = z
  .object({
    auditRunId: z
      .string()
      .uuid()
      .optional()
      .describe("A specific audit run (from list_quality_audits)."),
    deployRunId: z
      .string()
      .uuid()
      .optional()
      .describe("The newest audit of this staging deploy run."),
  })
  .strict();

const CATEGORY_LABEL: Record<string, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

function statusLine(run: AuditRun): string {
  switch (run.status) {
    case "queued":
    case "running":
      return `Audit ${run.status} — results land when it finishes; call this tool again in a minute.`;
    case "passed":
      return "Audit passed: no new problems.";
    case "problems":
      return `Audit found ${run.problemCount} problem(s).`;
    case "errored":
      return `Audit FAILED (${run.errorCode ?? "error"}): ${run.errorMessage ?? "no reason recorded"}. This is an infrastructure failure, not a verdict on the pages.`;
    case "skipped":
      return `No audit needed for this Stage: ${run.classification.skipped.join("; ") || "no rendering changes"}.`;
    case "superseded":
      return "Superseded by a newer Stage before it ran; that Stage's audit covers these pages.";
  }
}

function formatPage(p: AuditPage): string[] {
  const lines = [`## ${p.pageTitle} (${p.pagePath}) — ${p.status}`, `url: ${p.url}`];
  if (p.status === "errored") {
    lines.push(`error ${p.errorCode ?? ""}: ${p.errorMessage ?? ""}`);
    return lines;
  }
  if (p.scores) {
    lines.push(
      `scores (baseline): ${Object.entries(p.scores)
        .map(
          ([c, s]) =>
            `${CATEGORY_LABEL[c] ?? c} ${s} (${p.baselines[c as keyof typeof p.baselines]})`,
        )
        .join(", ")}; Performance runs ${p.performanceRuns.join("/")}`,
    );
  }
  for (const problem of p.problems) {
    if (problem.kind === "failing_audit") {
      lines.push(
        `- PROBLEM failing audit \`${problem.auditId}\` — ${problem.title}${problem.displayValue ? ` (${problem.displayValue})` : ""} [${problem.categories.join(", ")}]`,
      );
      // The flagged elements locate the fix (which module, which rule):
      // without them a color-contrast finding is guesswork.
      for (const el of problem.elements ?? []) {
        const where = [el.selector ? `\`${el.selector}\`` : null, el.snippet ?? null]
          .filter((x) => x !== null)
          .join(" ");
        lines.push(`  - element ${where}${el.explanation ? ` — ${el.explanation}` : ""}`);
      }
    } else {
      lines.push(
        `- PROBLEM ${CATEGORY_LABEL[problem.category] ?? problem.category} score ${problem.score} is below its baseline ${problem.baseline}`,
      );
    }
  }
  for (const h of p.heldBack) {
    lines.push(
      h.kind === "performance_drop"
        ? `- held back (noise guard): Performance ${h.score} < baseline ${h.baseline}; counts if the next audit shows it again`
        : `- held back (noise guard): \`${h.auditId}\` — ${h.title}; counts if the next audit shows it again`,
    );
  }
  return lines;
}

export const getQualityAuditTool = makeReadTool<z.infer<typeof getAuditInput>>({
  name: "get_quality_audit",
  description:
    "Read a Lighthouse quality audit of the staged site (Performance, Accessibility, Best Practices, SEO; mobile). " +
    "With no arguments: the newest audit of THIS chat's Stages. Shows per page the scores against the page's baseline, every problem with its Lighthouse audit id (e.g. `image-alt`, `color-contrast`, `meta-description`, `render-blocking-insight`) and the elements it flagged (CSS selector, HTML snippet, why — e.g. the measured contrast and colours), Performance signals the noise guard is holding back, and infrastructure errors. " +
    "A problem is a failing audit the editors have not accepted on that page, or a score below the page's baseline. Use this after a Stage to see what to fix; use list_quality_acceptances to see what editors already accepted. " +
    "Typical input: {} or { auditRunId }.",
  opName: "quality_audits.get",
  input: getAuditInput,
  buildOpInput: (input, _ctx, toolCtx) =>
    input.auditRunId || input.deployRunId
      ? input
      : toolCtx.chatSessionId
        ? { chatSessionId: toolCtx.chatSessionId }
        : {},
  format: (value) => {
    const v = value as AuditValue;
    if (!v.run) {
      return "No quality audit exists yet for this chat — audits run after a Stage that changes module code, layouts, templates, themes, new pages or plugin config.";
    }
    const r = v.run;
    const lines = [`audit ${r.id} (deploy run ${r.deployRunId}) — ${r.status}`, statusLine(r)];
    if (r.classification.reasons.length > 0) {
      lines.push(`audited because: ${r.classification.reasons.map((x) => x.label).join("; ")}`);
    }
    for (const p of v.pages) lines.push("", ...formatPage(p));
    return lines.join("\n");
  },
});

const checkStageInput = z.object({}).strict();

export const checkStageAuditTool = makeReadTool<z.infer<typeof checkStageInput>>({
  name: "check_stage_audit",
  description:
    "Before suggesting a Stage: will THIS chat's pending changes trigger a Lighthouse quality check, and why? " +
    "Audited: new or changed module html/css/js, layout / template / theme changes, new pages, plugin configuration. Not audited: only text and field values, placing or moving existing modules, SEO texts, redirects. " +
    "Lists the deciding changes and the pages the check would cover. Takes no input (uses the current chat).",
  opName: "quality_audits.classify_stage",
  input: checkStageInput,
  // Outside a chat (Power-MCP without a session) the op's own validation
  // rejects the missing id — there are no pending chat changes to classify.
  buildOpInput: (_input, _ctx, toolCtx) => ({ chatSessionId: toolCtx.chatSessionId ?? "" }),
  format: (value) => {
    const v = value as {
      classification: {
        auditNeeded: boolean;
        reasons: { rule: string; label: string }[];
        skipped: string[];
      };
      touchedPageIds: string[];
    };
    const c = v.classification;
    if (!c.auditNeeded) {
      return `The next Stage needs no quality check by its own changes (${c.skipped.join("; ") || "nothing pending"}). It can still be audited when this is the site's first Stage, a plugin was activated, or the previous check did not end clean.`;
    }
    return [
      `The next Stage will be quality-checked (Lighthouse) because: ${c.reasons.map((r) => `${r.rule} — ${r.label}`).join("; ")}.`,
      `Pages it touches: ${v.touchedPageIds.length} (the homepage is always included; up to 5 are audited). Publish live waits for the result.`,
    ].join("\n");
  },
});

const listAuditsInput = z
  .object({
    status: z
      .enum(["queued", "running", "passed", "problems", "errored", "skipped", "superseded"])
      .optional()
      .describe("Only runs that ended (or stand) in this status."),
    thisChatOnly: z.boolean().optional().describe("true: only audits of this chat's Stages."),
  })
  .strict();

export const listQualityAuditsTool = makeListReadTool<
  z.infer<typeof listAuditsInput>,
  AuditListRow
>({
  name: "list_quality_audits",
  description:
    "List recent quality audits of staging deploys, newest first (TOON rows: id, status, problems, pages, deployRunId, reasons, created). " +
    "Use to find an audit id for get_quality_audit, or to check whether the last Stage's audit is still running. Optional `status`, `thisChatOnly`; `filter`/`limit`/`offset`/`full` as usual.",
  opName: "quality_audits.list",
  input: listAuditsInput,
  buildOpInput: (input, _ctx, toolCtx) => ({
    ...(input.status ? { status: input.status } : {}),
    ...(input.thisChatOnly && toolCtx.chatSessionId
      ? { chatSessionId: toolCtx.chatSessionId }
      : {}),
    limit: input.full ? 200 : Math.min((input.offset ?? 0) + (input.limit ?? 20), 200),
  }),
  label: "quality_audits",
  rows: (value) => (value as { runs: AuditListRow[] }).runs,
  columns: [
    { key: "id", value: (r) => r.id },
    { key: "status", value: (r) => r.status },
    { key: "problems", value: (r) => r.problemCount },
    { key: "pages", value: (r) => r.pageCount },
    { key: "deployRunId", value: (r) => r.deployRunId },
    { key: "reasons", value: (r) => r.classification.reasons.map((x) => x.rule).join(" ") },
    { key: "created", value: (r) => r.createdAt },
  ],
  emptyMessage: "No quality audits yet.",
});

const listAcceptancesInput = z
  .object({
    pageId: z.string().uuid().optional().describe("Only this page's acceptances."),
    includeRevoked: z.boolean().optional().describe("Also show acceptances the Owner revoked."),
  })
  .strict();

export const listQualityAcceptancesTool = makeListReadTool<
  z.infer<typeof listAcceptancesInput>,
  AcceptanceRow
>({
  name: "list_quality_acceptances",
  description:
    "List quality findings and score drops editors accepted (TOON rows: page, kind, auditId, category, acceptedScore, reason, acceptedAt, revoked). " +
    "An acceptance applies ONLY to its page: the same Lighthouse audit failing on another page is still a problem there. Check this before asking an editor to accept something again. " +
    "`filter` searches the audit id, reason and page path server-side; optional `pageId`, `includeRevoked`.",
  opName: "quality_acceptances.list",
  input: listAcceptancesInput,
  buildOpInput: (input) => ({
    ...(input.pageId ? { pageId: input.pageId } : {}),
    ...(input.filter ? { query: input.filter } : {}),
    ...(input.includeRevoked ? { includeRevoked: true } : {}),
    limit: input.full ? 500 : Math.min((input.offset ?? 0) + (input.limit ?? 50), 500),
  }),
  label: "quality_acceptances",
  rows: (value) => (value as { acceptances: AcceptanceRow[] }).acceptances,
  columns: [
    { key: "page", value: (r) => r.pagePath },
    { key: "kind", value: (r) => r.kind },
    { key: "auditId", value: (r) => r.auditId },
    { key: "category", value: (r) => r.category },
    { key: "acceptedScore", value: (r) => r.acceptedScore },
    { key: "reason", value: (r) => r.reason },
    { key: "acceptedAt", value: (r) => r.acceptedAt },
    { key: "revoked", value: (r) => (r.revokedAt ? "yes" : "") },
  ],
  emptyMessage: "No accepted quality findings.",
});
