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
import { droppedSincePrevious } from "../../quality/ratchet.js";
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
    auditRunId: z.string().uuid().optional().describe("From `list_quality_audits`."),
    deployRunId: z
      .string()
      .uuid()
      .optional()
      .describe("The newest audit of this staging deploy run."),
    pageId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Only this page's section (id from `list_pages`); run summary + site-wide checks stay.",
      ),
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
  "Do not re-read it now: when the operator's chat is open, the result appears in this chat, and when it finds problems the operator is asked whether you should fix them — finish your turn with your summary. Only without an open chat (Power-MCP): call get_quality_audit again (it waits for the result) and fix every problem it names before you report back.";

function statusLine(run: AuditRun): string {
  switch (run.status) {
    case "queued":
    case "running":
      return `Audit ${run.status} — it takes 2–4 minutes. ${AUDIT_PENDING_NEXT_STEP}`;
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
 * What the AI does with open problems. An external agent read 92–97 and
 * reported the scores back instead of fixing them, so the instruction sits
 * at the end of the result, where the next action is decided — not only
 * in the tool description.
 */
export const AUDIT_FIX_LOOP_NEXT_STEP =
  "NEXT STEP — do not report these problems to the operator as a result; fix them now. " +
  "First every category marked DROPPED since the page's previous audit (look at the changes since then first), then every other PROBLEM: fix it in the module, page or theme the flagged elements and metrics name, call stage_changes, read get_quality_audit again, and repeat until the audit passes. " +
  "Performance is already the best of several runs (host noise only ever slows a run down, so the best run is the page itself): a score below 100 is not measurement noise — fix what the metrics name. " +
  "Go to the operator only with what you proved cannot be fixed in the site (a CAELO PLATFORM finding: bug_report; a fix that would break what the operator asked for), as one accept_quality_findings decision per group, with the reason why.";

/** Whether an audit result still has a problem no editor accepted. */
export function hasOpenProblems(v: {
  readonly pages: readonly { readonly problemAccepted: readonly boolean[] }[];
  readonly siteProblemAccepted: readonly boolean[];
}): boolean {
  return (
    v.pages.some((p) => p.problemAccepted.some((a) => !a)) || v.siteProblemAccepted.some((a) => !a)
  );
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
      const previous = p.previousScores?.[problem.category];
      const dropped =
        previous !== undefined && droppedSincePrevious(problem.category, problem.score, previous)
          ? ` — DROPPED since this page's previous audit (${previous} → ${problem.score}): check the changes since then first`
          : "";
      lines.push(
        `- ${tag} ${CATEGORY_LABEL[problem.category] ?? problem.category} score ${problem.score} is below the target 100${dropped}${accepted ? "" : " — not good enough: fix what pulls it down (the metrics above name the element)"}`,
      );
    }
  }
  lines.push(...formatCheckNotes(p.checkFindings));
  return lines;
}

/**
 * The get_quality_audit result: run status, why Lighthouse ran, the page
 * checks, every page, and — while a problem is open — the fix loop.
 */
export function formatAudit(value: unknown, input: { pageId?: string } = {}): string {
  const all = value as AuditValue;
  // A page filter narrows the per-page sections only: the run, its
  // status and the site-wide checks describe the whole Stage. A page the
  // audit does not cover is said so, never answered with an empty list.
  const v =
    input.pageId === undefined || !all.run
      ? all
      : { ...all, pages: all.pages.filter((p) => p.pageId === input.pageId) };
  if (input.pageId !== undefined && all.run && v.pages.length === 0) {
    const covered = all.pages.map((p) => `${p.pagePath} (${p.pageId})`).join(", ") || "(none)";
    return `audit ${all.run.id} has no result for page ${input.pageId}. Pages it covers: ${covered}. Call again without pageId for the whole audit.`;
  }
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
  if (r.status === "problems" && hasOpenProblems(v)) lines.push("", AUDIT_FIX_LOOP_NEXT_STEP);
  return lines.join("\n");
}

const readQualityAuditTool = makeReadTool<z.infer<typeof getAuditInput>>({
  name: "get_quality_audit",
  description:
    "Read the staged site's quality check: plugin page checks (when an active plugin adds any, e.g. SEO) reading EVERY page on every Stage, plus a mobile Lighthouse audit (Performance, Accessibility, Best Practices, SEO) when the Stage changed how pages render. No args = newest audit of THIS chat's Stages.\n" +
    "Returns per page: scores; Performance metrics (FCP, LCP, TBT, CLS, Speed Index: best run + Lighthouse rating; LCP element + breakdown; shifted elements + causes); each problem's Lighthouse audit id (e.g. `image-alt`, `color-contrast`, `render-blocking-insight`) + flagged elements (selector, HTML snippet, why, e.g. measured contrast); each page-check problem's rule id `<check>/<rule>` (contains a slash, e.g. `seo-check/title-missing`) + fix hint naming the tool. Plus site-wide findings, non-blocking warnings/hints, infrastructure errors.\n" +
    "USE FOR: after a Stage, what to fix. Already accepted -> `list_quality_acceptances`. Never run Lighthouse yourself: the audit runs on the real staged build (no other URL serves it).\n" +
    "CORE RULES:\n" +
    "- TARGET 100 IN EVERY CATEGORY + ZERO FINDINGS: every category <100, every scored Lighthouse audit below perfect, every page-check error BLOCKS Publish live. 90 is NOT acceptable — fix until 100 wherever achievable. ACCEPTED problems don't block (a worse value than accepted blocks again). Warnings/hints never block.\n" +
    "- Speed: fix the worst metric in the module rendering the named element, Stage again, re-read — repeat until Performance 100.\n" +
    "- Only the truly unfixable goes to the operator: one decision per group (`accept_quality_findings` with `groups`) + the reason.\n" +
    "- CAELO PLATFORM findings (back/forward cache, caching of Caelo's own files, server response, compression, redirects) come from Caelo's hosting/build: report via `bug_report`, never edit the site for them; they block until Caelo fixes it or the operator accepts.\n" +
    "- Without an open operator chat (Power-MCP) a call on a queued/running audit waits up to ~50 s; call again if still running.",
  opName: "quality_audits.get",
  input: getAuditInput,
  // `pageId` filters the formatted result; the op reads whole audits.
  buildOpInput: ({ pageId: _pageId, ...input }, _ctx, toolCtx) =>
    input.auditRunId || input.deployRunId
      ? input
      : toolCtx.chatSessionId
        ? { chatSessionId: toolCtx.chatSessionId }
        : {},
  format: formatAudit,
});

/** Bounded wait for a running audit: under the MCP SDK client's default
 *  60 s request timeout, like the approval wait (mcp-server approval-wait.ts). */
export const AUDIT_WAIT_MS = 50_000;
const AUDIT_POLL_INTERVAL_MS = 5_000;

function auditPending(value: unknown): boolean {
  const status = (value as AuditValue | undefined)?.run?.status;
  return status === "queued" || status === "running";
}

/**
 * Re-read while the audit is queued or running, until it settles, the
 * wait ends or the turn is stopped. Returns the last read.
 */
export async function readUntilSettled<R extends { ok: boolean; value?: unknown }>(
  read: () => Promise<R>,
  opts: {
    readonly waitMs: number;
    readonly intervalMs: number;
    readonly signal?: AbortSignal;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
  },
): Promise<R> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.waitMs;
  let result = await read();
  while (result.ok && auditPending(result.value) && now() < deadline && !opts.signal?.aborted) {
    await sleep(opts.intervalMs);
    result = await read();
  }
  return result;
}

/**
 * get_quality_audit. An agent without an open operator chat is told the
 * result nowhere else, so a read of a running audit waits for it instead
 * of answering "running — read again later": the external agent that got
 * that answer reported a half-finished state to the operator and never
 * came back to fix the scores. The Live Edit chat never waits — the
 * result reaches that chat on its own (AUDIT_PENDING_NEXT_STEP).
 */
export const getQualityAuditTool: typeof readQualityAuditTool = {
  ...readQualityAuditTool,
  handler: (ctx, input, toolCtx) => {
    const read = () => readQualityAuditTool.handler(ctx, input, toolCtx);
    if (toolCtx.operatorBrowserAttached === true) return read();
    return readUntilSettled(read, {
      waitMs: AUDIT_WAIT_MS,
      intervalMs: AUDIT_POLL_INTERVAL_MS,
      ...(toolCtx.abortSignal ? { signal: toolCtx.abortSignal } : {}),
    });
  },
};

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
    "Before suggesting a Stage: will THIS chat's pending changes trigger a Lighthouse audit, and why? (Active plugin page checks read every page on EVERY Stage regardless.) Lighthouse runs for new/changed module html/css/js, layout/template/theme changes, new pages, plugin config — not for only text/field values, placing/moving existing modules, SEO texts, redirects. " +
    "Returns the deciding changes, covered pages, and last Performance metrics (FCP, LCP, TBT, CLS, Speed Index; LCP element, layout shifts) of those pages + homepage — the start for a speed fix (target Performance 100). Never run Lighthouse yourself: the audit runs on the real staged build.",
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
      .describe("Current or final status."),
    thisChatOnly: z.boolean().optional().describe("Only this chat's Stages."),
  })
  .strict();

export const listQualityAuditsTool = makeListReadTool<
  z.infer<typeof listAuditsInput>,
  AuditListRow
>({
  name: "list_quality_audits",
  description:
    "List recent quality audits of staging deploys, newest first. Find an audit id for `get_quality_audit` or check whether the last Stage's audit still runs.",
  opName: "quality_audits.list",
  input: listAuditsInput,
  listParamDescriptions: { limit: "Default 20." },
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
    includeRevoked: z.boolean().optional().describe("Include Owner-revoked ones."),
  })
  .strict();

export const listQualityAcceptancesTool = makeListReadTool<
  z.infer<typeof listAcceptancesInput>,
  AcceptanceRow
>({
  name: "list_quality_acceptances",
  description:
    "List accepted quality findings, category scores <100 and page-check rules. Check before asking the operator to decide something again. " +
    "An acceptance applies ONLY to its page (`site-wide` = site-wide page-check rule). It records the accepted value — `score`: category score; `finding`: audit score in points (acceptedScore); `check`: up to acceptedCount errors of its rule (auditId = rule id); a worse value blocks again. `filter` searches audit/rule id, reason, page path.",
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
