// SPDX-License-Identifier: MPL-2.0

/**
 * issue #197 — the migration's added-value surface. The AI reads
 * every page anyway while rebuilding; recording what it noticed
 * (typos fixed, dead links found, thin pages) turns "wir haben
 * kopiert" into "wir haben es besser gemacht" — and gives the
 * operator the natural next conversation.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { formatMicrocentsAsMoney } from "../../ops/imports-cost.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const notesInput = z
  .object({
    importPageId: z.string().uuid(),
    notes: z
      .array(
        z
          .object({
            category: z.enum(["typo", "dead_link", "missing_alt", "thin_content", "improvement"]),
            note: z.string().min(1).max(1000),
            applied: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
type NotesInput = z.infer<typeof notesInput>;

export const addImportPageNotesTool: ToolDefinitionWithHandler<NotesInput> = {
  name: "add_import_page_notes",
  description:
    "Record findings you made while rebuilding an imported page: typos (fix obvious ones in the rebuilt content and set applied: true), dead links, missing image alt texts, thin content, improvement ideas (applied: false — the operator decides). BATCH all of a page's notes in ONE call. `importPageId` accepts EITHER id: the staging import_pages id OR the composed CMS page id you just built (from accept_page / compose_from_run) — both work, no need to look one up from the other. These feed the migration report the operator receives at the end — record honestly, including what you could not fix.",
  schema: notesInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["importPageId", "notes"],
    properties: {
      importPageId: {
        type: "string",
        format: "uuid",
        description:
          "The page to attach notes to — pass EITHER the staging import_pages id OR the composed CMS page id (accepted_page_id). Both resolve to the same import page.",
      },
      notes: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "note", "applied"],
          properties: {
            category: {
              type: "string",
              enum: ["typo", "dead_link", "missing_alt", "thin_content", "improvement"],
            },
            note: { type: "string", minLength: 1, maxLength: 1000 },
            applied: {
              type: "boolean",
              description: "true = you fixed it during the rebuild; false = suggestion only.",
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.add_page_notes",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `add_import_page_notes failed: ${describeError(r.error)}` };
    }
    const v = r.value as { totalNotes: number };
    return {
      ok: true,
      content: `${input.notes.length} note(s) recorded (${v.totalNotes} total on this page).`,
    };
  },
};

const reportInput = z.object({ runId: z.string().uuid() }).strict();
type ReportInput = z.infer<typeof reportInput>;

interface Report {
  sourceUrl: string;
  status: string;
  pagesSeen: number;
  pagesExtracted: number;
  acceptedPages: number;
  clusters: { clusterKey: string; label: string | null; count: number }[];
  redirectsCreated: number;
  crawlErrors: { url: string; reason: string }[];
  pagesMissingScreenshot: number;
  fidelity: {
    pass: number;
    warn: number;
    fail: number;
    unverified: number;
    overThreshold: { sourceUrl: string; diffStatus: "warn" | "fail"; diffPct: number }[];
  };
  siteDesignTokens: unknown;
  boilerplate: {
    pagesAnalyzed?: number;
    candidates?: {
      tag: string;
      pageCount: number;
      suggestedPlacement: string;
      placementReason: string;
      sampleText: string;
    }[];
  } | null;
  notes: {
    category: string;
    applied: number;
    suggested: number;
    samples: { sourceUrl: string; note: string; applied: boolean }[];
  }[];
  // issue #28 — the run-scoped error/warning ledger.
  eventCounts: { error: number; warning: number; info: number };
  events: {
    id: string;
    severity: "warning" | "error" | "info";
    phase: string | null;
    message: string;
    detail: unknown;
    pageId: string | null;
    createdAt: string | null;
  }[];
}

export const getImportRunReportTool: ToolDefinitionWithHandler<ReportInput> = {
  name: "get_import_run_report",
  description:
    "Fetch the migration run's rollup: pages built per confirmed type, redirects created, crawl fetch errors, and your recorded notes (applied vs suggested per category). Call it when the migration is DONE and close the conversation with it in plain words — what was preserved, what you fixed, what the operator should look at. Do not paste the raw data; narrate it.",
  schema: reportInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: { runId: { type: "string", format: "uuid" } },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.get_run_report",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `get_import_run_report failed: ${describeError(r.error)}` };
    }
    const v = r.value as Report;

    // issue #298 — observed vs estimated, the estimator's learning loop.
    // Best-effort like the cost line: a calibration-read failure must not
    // sink the report.
    let calibrationLine = "";
    const calR = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.get_run_calibration",
      input,
    );
    if (calR.ok) {
      const cal = calR.value as {
        observed: {
          turnCount: number;
          inputTokens: number;
          outputTokens: number;
          spentMicrocents: number;
          pagesBuilt: number;
          apiCallsInferred: number;
        };
        estimated: { pages: number; aiCostUsdLow: number; aiCostUsdHigh: number } | null;
        derived: { callsPerPage: number | null; baseContextTokensPerCall: number | null };
      };
      const o = cal.observed;
      if (o.turnCount > 0) {
        const spent = formatMicrocentsAsMoney(o.spentMicrocents, "USD");
        const estimatedPart = cal.estimated
          ? `estimated $${cal.estimated.aiCostUsdLow}–$${cal.estimated.aiCostUsdHigh} for ${cal.estimated.pages} page(s); `
          : "no cost band was estimated for this run; ";
        const derivedPart =
          cal.derived.callsPerPage !== null && cal.derived.baseContextTokensPerCall !== null
            ? ` Observed constants: ~${cal.derived.callsPerPage.toFixed(1)} calls/page, ~${Math.round(cal.derived.baseContextTokensPerCall / 1000)}K base context/call.`
            : "";
        calibrationLine = `Estimator calibration — ${estimatedPart}observed ${spent} (${(o.inputTokens / 1e6).toFixed(1)}M input / ${(o.outputTokens / 1e3).toFixed(0)}K output tokens over ${o.turnCount} turn(s), ${o.pagesBuilt} page(s) built).${derivedPart}`;
      }
    }

    // issue #280 — fold the run's cost picture into the closing report so
    // the operator hears what the migration cost, not just what it built.
    // Best-effort: a cost-read failure must not sink the whole report.
    let costLine = "";
    const costR = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.get_run_cost",
      input,
    );
    if (costR.ok) {
      const c = costR.value as {
        spentMicrocents: number;
        ceilingMicrocents: number | null;
        ceilingCurrency: string | null;
        overBudget: boolean;
      };
      const currency = c.ceilingCurrency ?? "USD";
      const spent = formatMicrocentsAsMoney(c.spentMicrocents, currency);
      costLine =
        c.ceilingMicrocents === null
          ? `Cost: ${spent} in AI spend across the orchestrator + subagents (no budget ceiling was set).`
          : `Cost: ${spent} spent of a ${formatMicrocentsAsMoney(c.ceilingMicrocents, currency)} budget${
              c.overBudget
                ? " — budget reached; say so plainly and let the operator decide next steps"
                : ""
            }.`;
    }

    const lines = [
      `# Migration report — ${v.sourceUrl} (${v.status})`,
      costLine,
      calibrationLine,
      `Pages: ${v.acceptedPages} built of ${v.pagesExtracted} extracted (${v.pagesSeen} URLs seen). Redirects created: ${v.redirectsCreated}.`,
      v.clusters.length > 0
        ? `Page types: ${v.clusters.map((c) => `${c.label ?? c.clusterKey} ×${c.count}`).join(", ")}`
        : "",
      v.crawlErrors.length > 0
        ? `Crawl errors (${v.crawlErrors.length}): ${v.crawlErrors
            .slice(0, 8)
            .map((e) => `${e.url} (${e.reason})`)
            .join("; ")}${v.crawlErrors.length > 8 ? "; …" : ""}`
        : "Crawl errors: none.",
      // issue #247 — design ground truth status. Screenshot gaps are
      // UNVERIFIED pages the operator must hear about; sampled tokens
      // are what the model should base theme statements on.
      v.pagesMissingScreenshot > 0
        ? `WARNING: ${v.pagesMissingScreenshot} page(s) have NO stored source screenshot (see notes/screenshot_missing) — they are UNVERIFIED: nothing confirms their rebuild matches the original. Tell the operator plainly.`
        : "Source screenshots: every page has one.",
      // issue #250 (WS4) — fidelity rollup. Over-threshold pages MUST be
      // named in the closing message: never report "fertig" over red pages.
      v.fidelity.overThreshold.length > 0
        ? `FIDELITY — ${v.fidelity.fail} failed + ${v.fidelity.warn} warn of the graded rebuilds diverge from their originals; surface these to the operator (do NOT call the migration done while they read red): ${v.fidelity.overThreshold
            .slice(0, 10)
            .map((p) => `${p.sourceUrl} (${p.diffStatus} ${(p.diffPct * 100).toFixed(0)}%)`)
            .join("; ")}${v.fidelity.overThreshold.length > 10 ? "; …" : ""}.`
        : v.fidelity.pass > 0
          ? `Fidelity: ${v.fidelity.pass} rebuilt page(s) verified against their originals; none over threshold.`
          : "Fidelity: no pages graded yet — run verify_import_page_fidelity on the rebuilt pages (start with the homepage) before reporting done.",
      v.fidelity.unverified > 0
        ? `${v.fidelity.unverified} composed page(s) were never fidelity-graded (verify_import_page_fidelity not run, or no source screenshot) — they are UNVERIFIED; tell the operator which parts of the rebuild you actually measured.`
        : "",
      v.siteDesignTokens
        ? `Sampled design tokens (computed-style ground truth) are stored on this run: ${JSON.stringify(v.siteDesignTokens).slice(0, 1500)} — compose_from_import already applied them to the theme; cite THESE values (not guesses) when discussing the site's colors/fonts.`
        : "No sampled design tokens on this run (fetch-only crawl) — theme values came from the inline-CSS extractor.",
      // issue #248 (WS2) — surface detected boilerplate: blocks that
      // should be ONE shared module, not copied per page.
      v.boilerplate?.candidates && v.boilerplate.candidates.length > 0
        ? `Boilerplate detected (blocks repeating across pages — each should be ONE shared module, not per-page copies): ${v.boilerplate.candidates
            .slice(0, 8)
            .map(
              (c) =>
                `<${c.tag}> ×${c.pageCount} → ${c.suggestedPlacement} ("${c.sampleText.slice(0, 48)}")`,
            )
            .join("; ")}`
        : "",
      ...v.notes.map(
        (n) =>
          `Notes/${n.category}: ${n.applied} fixed, ${n.suggested} suggested. Samples: ${n.samples
            .map((s) => `"${s.note}" (${s.applied ? "fixed" : "suggested"}, ${s.sourceUrl})`)
            .join("; ")}`,
      ),
      // issue #28 — the run's error/warning LEDGER. Every problem hit during
      // the migration, consolidated. The operator ASKED for all migration
      // errors to be reviewable; report them verbatim — do NOT call the
      // migration clean while errors remain in the ledger.
      v.events.length > 0
        ? `ERROR/WARNING LEDGER — ${v.eventCounts.error} error(s), ${v.eventCounts.warning} warning(s), ${v.eventCounts.info} info logged during this migration. Surface these to the operator (report them verbatim; never claim a clean migration while errors are present):\n${v.events
            .slice(0, 40)
            .map(
              (e) => `- [${e.severity.toUpperCase()}${e.phase ? `/${e.phase}` : ""}] ${e.message}`,
            )
            .join(
              "\n",
            )}${v.events.length > 40 ? `\n- …and ${v.events.length - 40} more (see the run report queue)` : ""}`
        : "Error/warning ledger: empty — nothing was flagged during this migration.",
      "",
      "Narrate this to the operator in plain words — preserved / fixed / worth-a-look.",
    ].filter((l) => l !== "");
    return { ok: true, content: lines.join("\n") };
  },
};
