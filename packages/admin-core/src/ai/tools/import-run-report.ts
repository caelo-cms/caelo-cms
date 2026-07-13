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
    const lines = [
      `# Migration report — ${v.sourceUrl} (${v.status})`,
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
      "",
      "Narrate this to the operator in plain words — preserved / fixed / worth-a-look.",
    ].filter((l) => l !== "");
    return { ok: true, content: lines.join("\n") };
  },
};
