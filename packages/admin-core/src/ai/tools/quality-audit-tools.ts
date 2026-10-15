// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the AI's read surface of the quality gate (CLAUDE.md §11:
 * on-demand list_/get_ tools, no system-prompt context block).
 *
 *   get_quality_audit         the full findings of one audit: per page the
 *                             scores vs. the 100 target, the Performance
 *                             metrics (FCP, LCP, TBT, CLS, SI), every problem
 *                             with its Lighthouse audit id or page-check rule
 *                             id (#727, with its fix hint) — accepted ones
 *                             marked — and infrastructure errors.
 *   check_stage_audit         whether the next Stage runs Lighthouse, and the
 *                             last measured metrics of the pages it touches.
 *   list_quality_audits       recent audit runs and how they ended.
 *   list_quality_acceptances  findings / score drops editors accepted, per
 *                             page — so the AI never asks twice.
 */

import { z } from "zod";
import type { classifyStageOp } from "../../ops/quality/classify_stage.js";
import type { getAuditOp, listAcceptancesOp, listAuditsOp } from "../../ops/quality/read.js";
import { findingOwner } from "../../quality/platform-audits.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";
import {
  formatCheckNotes,
  formatCheckProblem,
  formatChecksSummary,
} from "./quality-check-format.js";
import { formatMetrics, inlineCode } from "./quality-metrics-format.js";

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

/**
 * What to do while a check runs. Polling it costs a full model call per
 * read (the PR #624 homepage turn re-read a running audit 19 times and
 * blew its token ceiling) while the result is delivered anyway: the
 * operator's open chat shows it when the check settles, and asks the
 * operator before a fix round starts (#685).
 */
export const AUDIT_PENDING_NEXT_STEP =
  "Do not re-read it now: when the operator's chat is open, the result appears in this chat, and when it finds problems the operator is asked whether you should fix them — finish your turn with your summary. Only without an open chat (Power-MCP) read it again after a couple of minutes.";

function statusLine(run: AuditRun): string {
  switch (run.status) {
    case "queued":
    case "running":
      return `Audit ${run.status} — it takes 1–2 minutes. ${AUDIT_PENDING_NEXT_STEP}`;
    case "passed":
      return "Audit passed: 100 in every category and no findings.";
    case "problems":
      return `Audit found ${run.problemCount} problem(s) off the target (100 in every category, zero findings); those an editor accepted are marked and do not block.`;
    case "errored":
      return `Audit FAILED (${run.errorCode ?? "error"}): ${run.errorMessage ?? "no reason recorded"}. This is an infrastructure failure, not a verdict on the pages.`;
    case "skipped":
      return `Nothing to check for this Stage: ${run.classification.skipped.join("; ") || "no published pages"}.`;
    case "superseded":
      return "Superseded by a newer Stage before it ran; that Stage's audit covers these pages.";
  }
}

/**
 * #667 — where the fix of a failing audit belongs, appended to its line.
 * Without it the AI guessed ("this comes from the hosting") and argued for
 * accepting what were Caelo bugs.
 */
function ownerNote(owner: ReturnType<typeof findingOwner>): string {
  switch (owner) {
    case "platform":
      return " — CAELO PLATFORM: decided by Caelo's hosting/build setup, not by this site. Do not edit the site for it: report it with bug_report and tell the operator it is a Caelo issue you reported. Publish live stays blocked until Caelo fixes it or the operator decides to accept it (you may hand them that decision per group, explained — never recommend it).";
    case "site":
      return " — caused by this site: the flagged URLs/reasons point at a module's script or third-party embed; fix that module.";
    case "check":
      return " — read the flagged items: same-site files (/_assets/…, /_caelo/…, pages) and browser-flag or response-header reasons are a CAELO PLATFORM issue (report with bug_report, do not edit the site for it); third-party URLs and script reasons (e.g. an unload handler) are fixed in the module; any other browser reason (e.g. memory) is neither — describe it, don't change the site for it.";
    case null:
      return "";
  }
}

/**
 * One audited page as the AI reads it in `get_quality_audit`: scores vs.
 * the 100 target, each problem with the elements / console entries that
 * locate its fix, accepted problems marked as such.
 *
 * @returns the page's lines (joined by the tool's formatter)
 */
export function formatPage(p: AuditPage): string[] {
  const lines = [`## ${p.pageTitle} (${p.pagePath}) — ${p.status}`, `url: ${p.url}`];
  if (p.status === "errored") {
    lines.push(`error ${p.errorCode ?? ""}: ${p.errorMessage ?? ""}`);
    return lines;
  }
  if (p.scores) {
    lines.push(
      `scores (target 100 each): ${Object.entries(p.scores)
        .map(([c, s]) => `${CATEGORY_LABEL[c] ?? c} ${s}`)
        .join(", ")}; Performance runs ${p.performanceRuns.join("/")}`,
    );
  }
  if (p.metrics) lines.push(...formatMetrics(p.metrics));
  for (const [index, problem] of p.problems.entries()) {
    const accepted = p.problemAccepted[index] === true;
    const tag = accepted
      ? "ACCEPTED by an editor (does not block; leave it unless asked)"
      : "PROBLEM";
    if (problem.kind === "check_rule") {
      lines.push(...formatCheckProblem(problem, accepted));
    } else if (problem.kind === "failing_audit") {
      lines.push(
        `- ${tag} failing audit \`${problem.auditId}\` — ${problem.title}${problem.displayValue ? ` (${problem.displayValue})` : ""} [${problem.categories.join(", ")}]${ownerNote(findingOwner(problem.auditId, problem.elements ?? [], p.url))}`,
      );
      // The flagged elements locate the fix (which module, which rule):
      // without them a color-contrast finding is guesswork.
      for (const el of problem.elements ?? []) {
        // The snippet is the STAGED build's markup (deploy URLs such as
        // /_assets/<slug>.<hash>.png): quoted as code, never as live HTML — the
        // chat renders tool results as markdown, and a bare `<img>` made
        // the operator's browser fetch a URL the admin does not serve
        // (404s in the console of the homepage real-AI run, PR #624).
        const where = [
          el.selector ? inlineCode(el.selector) : null,
          el.snippet ? inlineCode(el.snippet) : null,
        ]
          .filter((x) => x !== null)
          .join(" ");
        if (where === "" && (el.explanation || el.url)) {
          // A node-less entry: a console / network message (errors-in-console)
          // or a flagged resource / reason (caching, compression, bf-cache —
          // #667). Its message and URL name the cause. The URL is code too.
          const kind = problem.auditId === "errors-in-console" ? "console" : "flagged";
          lines.push(
            `  - ${kind} ${el.url ? `${inlineCode(el.url)} ` : ""}${el.explanation ? `— ${el.explanation}` : ""}`.trimEnd(),
          );
          continue;
        }
        if (where === "" && el.label) {
          // The truncation marker (or a bare label): print it as is.
          lines.push(`  - ${el.label}`);
          continue;
        }
        lines.push(`  - element ${where}${el.explanation ? ` — ${el.explanation}` : ""}`);
      }
    } else {
      lines.push(
        `- ${tag} ${CATEGORY_LABEL[problem.category] ?? problem.category} score ${problem.score} is below the target 100${accepted ? "" : " — not good enough: fix what pulls it down (the metrics above name the element)"}`,
      );
    }
  }
  lines.push(...formatCheckNotes(p.checkFindings));
  return lines;
}

export const getQualityAuditTool = makeReadTool<z.infer<typeof getAuditInput>>({
  name: "get_quality_audit",
  description:
    "Read the quality check of the staged site: the page checks plugins add (such as SEO checks; when an active plugin adds any) that read EVERY page on every Stage, plus a Lighthouse audit (Performance, Accessibility, Best Practices, SEO; mobile) when the Stage changed how pages render. " +
    "With no arguments: the newest audit of THIS chat's Stages. Shows per page the scores (the target is 100 in every category), the Performance metrics behind the Performance score (FCP, LCP, TBT, CLS, Speed Index: the median over the runs with Lighthouse's rating, plus the LCP element, the LCP breakdown and the elements that shifted with their causes), every problem with its Lighthouse audit id (e.g. `image-alt`, `color-contrast`, `meta-description`, `render-blocking-insight`) and the elements it flagged (CSS selector, HTML snippet, why — e.g. the measured contrast and colours), every page-check problem with its rule id (`<check>/<rule>`, e.g. `seo-check/title-missing` — rule ids contain a slash) and a fix hint naming the tool to use, site-wide findings, non-blocking warnings and hints, and infrastructure errors. " +
    "THE TARGET IS 100 IN EVERY CATEGORY AND ZERO FINDINGS: every category below 100, every scored Lighthouse audit below a perfect score, and every page-check error is a PROBLEM that blocks Publish live. A score like 90 is NOT acceptable on its own — keep fixing until 100 wherever achievable. Problems an editor accepted are marked ACCEPTED and do not block (a worse value than accepted blocks again). Warnings and hints never block. Use this after a Stage to see what to fix; use list_quality_acceptances to see what editors already accepted. " +
    "To make a page faster, read its metrics here and fix the worst one in the module that renders the named element, then Stage again and re-read — repeat until Performance is 100. Use this instead of running Lighthouse yourself: the audit runs against the real staged build, which no other URL serves. Only what truly cannot be fixed goes to the operator, as one decision per group (accept_quality_findings with groups), with the reason why. " +
    "A finding marked CAELO PLATFORM (back/forward cache, caching of Caelo's own files, server response, compression, redirects) is decided by Caelo's hosting/build setup, not by the site: report it with bug_report and never edit the site for it; it blocks until Caelo fixes it or the operator decides to accept it. " +
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
      return "No quality audit exists yet for this chat — every Stage is checked (plugin page checks, when any is active, on every page; Lighthouse when module code, layouts, templates, the theme, new pages or plugin config changed).";
    }
    const r = v.run;
    const lines = [`audit ${r.id} (deploy run ${r.deployRunId}) — ${r.status}`, statusLine(r)];
    if (r.classification.auditNeeded) {
      lines.push(
        `Lighthouse ran because: ${r.classification.reasons.map((x) => x.label).join("; ")}`,
      );
    } else if (r.status !== "skipped") {
      lines.push(
        `Lighthouse not needed for this Stage (${r.classification.skipped.slice(0, 3).join("; ") || "no rendering changes"}).`,
      );
    }
    if (v.checks) lines.push(...formatChecksSummary(v.checks, v.siteProblemAccepted));
    for (const p of v.pages) lines.push("", ...formatPage(p));
    return lines.join("\n");
  },
});

const checkStageInput = z.object({}).strict();

type StageValue = z.infer<(typeof classifyStageOp)["output"]>;

/** The last measured metrics of the pages a Stage touches (check_stage_audit). */
function formatLastMetrics(pages: NonNullable<StageValue["lastMetrics"]>): string[] {
  if (pages.length === 0) {
    return [
      "No Lighthouse metrics measured yet for these pages or the homepage: they appear after the first Stage that runs Lighthouse.",
    ];
  }
  const lines = ["Last measured on the staged build (newest Lighthouse audit per page):"];
  for (const p of pages) {
    lines.push(
      "",
      `## ${p.pageTitle} (${p.pagePath}) — audit ${p.auditRunId}, ${p.measuredAt}`,
      ...formatMetrics(p.metrics),
    );
  }
  return lines;
}

export const checkStageAuditTool = makeReadTool<z.infer<typeof checkStageInput>>({
  name: "check_stage_audit",
  description:
    "Before suggesting a Stage: will THIS chat's pending changes trigger a Lighthouse audit, and why? (Plugin page checks, when any is active, read every page on EVERY Stage regardless.) " +
    "Lighthouse runs for: new or changed module html/css/js, layout / template / theme changes, new pages, plugin configuration. Not for: only text and field values, placing or moving existing modules, SEO texts, redirects. " +
    "Lists the deciding changes and the pages the check would cover, plus the last measured Performance metrics (FCP, LCP, TBT, CLS, Speed Index; LCP element, layout shifts) of those pages and the homepage — the starting point for a speed fix (the target is Performance 100). Use this instead of running Lighthouse yourself: the audit runs against the real staged build. Takes no input (uses the current chat).",
  opName: "quality_audits.classify_stage",
  input: checkStageInput,
  // Outside a chat (Power-MCP without a session) the op's own validation
  // rejects the missing id — there are no pending chat changes to classify.
  buildOpInput: (_input, _ctx, toolCtx) => ({
    chatSessionId: toolCtx.chatSessionId ?? "",
    includeLastMetrics: true,
  }),
  format: (value) => {
    const v = value as StageValue;
    const c = v.classification;
    const verdict = c.auditNeeded
      ? [
          `The next Stage will be quality-checked (Lighthouse) because: ${c.reasons.map((r) => `${r.rule} — ${r.label}`).join("; ")}.`,
          `Pages it touches: ${v.touchedPageIds.length} (the homepage is always included; up to 5 are audited by Lighthouse; plugin page checks, when any is active, read every page). Publish live waits for the result.`,
        ]
      : [
          `The next Stage needs no Lighthouse audit by its own changes (${c.skipped.join("; ") || "nothing pending"}); plugin page checks, when any is active, still read every page and Publish live waits for them. Lighthouse can still run when this is the site's first Stage, a plugin was activated, or the previous Lighthouse audit did not end clean.`,
        ];
    return [...verdict, "", ...formatLastMetrics(v.lastMetrics ?? [])].join("\n");
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
    "List quality findings, category scores below 100 and page-check rules editors accepted (TOON rows: page, kind, auditId, category, acceptedScore, acceptedCount, reason, acceptedAt, revoked). " +
    "An acceptance applies ONLY to its page (page `site-wide` = a site-wide page-check rule): the same finding on another page is still a problem there. It records the value accepted — a `score` acceptance the category score, a `finding` acceptance the audit's score in points (acceptedScore), a `check` acceptance up to acceptedCount errors of its rule (auditId holds the rule id) — and a worse value blocks again. Check this before asking the operator to decide on something again. " +
    "`filter` searches the audit/rule id, reason and page path server-side; optional `pageId`, `includeRevoked`.",
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
    { key: "acceptedCount", value: (r) => r.acceptedCount },
    { key: "reason", value: (r) => r.reason },
    { key: "acceptedAt", value: (r) => r.acceptedAt },
    { key: "revoked", value: (r) => (r.revokedAt ? "yes" : "") },
  ],
  emptyMessage: "No accepted quality findings.",
});
