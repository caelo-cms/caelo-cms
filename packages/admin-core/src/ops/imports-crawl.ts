// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1360 — the crawl's side of an import run, now that the crawl runs
 * in a reporting job (site-import/crawl-job.ts) and not in the admin:
 *
 *   imports.claim_crawl           the job takes the run it was started for:
 *                                 its scope and the checkpoint to resume from
 *   imports.take_render           one render of the run, within its budget
 *   imports.save_crawl_checkpoint the frontier after a batch, so a killed job
 *                                 resumes instead of starting over
 *   imports.list_capture_targets  the pages the ground-truth pass renders
 *   imports.add_crawl_page_note   a loud note on one page of the run
 *   imports.finish_crawl          the crawl is done: ready for review, the
 *                                 run report's error and skip ledger kept
 *   imports.sweep_unstarted_crawls the tick's backstop: crawling runs with no
 *                                 job
 *
 * All system-only: the job reaches them only through its reports
 * (site-import/import-job-kind.ts), which check every input first. Each
 * names its run and touches nothing of another one.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";

const runId = z.string().uuid();

/**
 * A crawl run whose job has not reported for this long was started by the
 * in-process worker of a release before #1360, which has stopped: its own
 * zombie window, so an admin still on that release during a roll keeps it.
 */
const LEGACY_STALE_MINUTES = 15;

export const claimCrawlOp = defineOperation({
  name: "imports.claim_crawl",
  readScope: "request",
  // Why system-only: job-internal — the crawl's job claims the run it was
  // started for (#1360); a person or the AI starts a crawl with
  // imports.create_run / propose_site_import.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId }).strict(),
  output: z.object({
    /** `claimed`: crawling, now the job's; `settled`: not crawling (any more); `missing`: deleted. */
    state: z.enum(["claimed", "settled", "missing"]),
    run: z
      .object({
        sourceUrl: z.string(),
        depth: z.number().int(),
        maxPages: z.number().int(),
        /** The stored columns as they are; the caller parses them loudly. */
        explicitUrls: z.unknown(),
        crawlScope: z.unknown(),
        crawlState: z.unknown(),
        status: z.string(),
        /** Renders the run asked for so far (its budget: `renderBudget`). */
        crawlRenders: z.number().int(),
      })
      .nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT source_url, depth, max_pages, explicit_urls, crawl_scope, crawl_state, status,
             crawl_renders
      FROM import_runs WHERE id = ${input.runId}::uuid
      FOR UPDATE
    `)) as unknown as {
      source_url: string;
      depth: number;
      max_pages: number;
      explicit_urls: unknown;
      crawl_scope: unknown;
      crawl_state: unknown;
      status: string;
      crawl_renders: number;
    }[];
    const row = rows[0];
    if (!row) return ok({ state: "missing" as const, run: null });
    if (row.status !== "crawling") return ok({ state: "settled" as const, run: null });
    await tx.execute(sql`
      UPDATE import_runs SET started_at = COALESCE(started_at, now()), heartbeat_at = now()
      WHERE id = ${input.runId}::uuid
    `);
    return ok({
      state: "claimed" as const,
      run: {
        sourceUrl: row.source_url,
        depth: row.depth,
        maxPages: row.max_pages,
        explicitUrls: row.explicit_urls,
        crawlScope: row.crawl_scope,
        crawlState: row.crawl_state,
        status: row.status,
        crawlRenders: row.crawl_renders,
      },
    });
  },
});

/**
 * Renders one crawl may ask for: each page once, the second pass twice
 * (one retry), and slack for redirects. A crawl past it is a job gone
 * wrong, not a site.
 */
export function renderBudget(maxPages: number): number {
  return 3 * maxPages + 50;
}

export const takeRenderOp = defineOperation({
  name: "imports.take_render",
  readScope: "request",
  // Why system-only: see imports.claim_crawl. The budget is the admin's own
  // bound on a job it trusts no more than its data (#1360).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId }).strict(),
  output: z.object({
    /** `taken`: render it; `not-crawling`: the run ended; `over-budget`: refused. */
    state: z.enum(["taken", "not-crawling", "over-budget"]),
    budget: z.number().int().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT status, max_pages, crawl_renders FROM import_runs
      WHERE id = ${input.runId}::uuid
      FOR UPDATE
    `)) as unknown as { status: string; max_pages: number; crawl_renders: number }[];
    const row = rows[0];
    if (row?.status !== "crawling") return ok({ state: "not-crawling" as const, budget: null });
    const budget = renderBudget(row.max_pages);
    if (row.crawl_renders >= budget) return ok({ state: "over-budget" as const, budget });
    await tx.execute(sql`
      UPDATE import_runs SET crawl_renders = crawl_renders + 1, heartbeat_at = now()
      WHERE id = ${input.runId}::uuid
    `);
    return ok({ state: "taken" as const, budget });
  },
});

export const addCrawlPageNoteOp = defineOperation({
  name: "imports.add_crawl_page_note",
  readScope: "request",
  // Why system-only: see imports.claim_crawl. The AI's own notes go through
  // imports.add_page_notes, which also takes a built page's id.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId,
      importPageId: z.string().uuid(),
      category: z.enum(["screenshot_missing", "design_tokens_missing"]),
      note: z.string().min(1).max(1000),
    })
    .strict(),
  output: z.object({ noted: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const note = [{ category: input.category, note: input.note, applied: false }];
    const rows = (await tx.execute(sql`
      UPDATE import_pages p
         -- (::text)::jsonb keeps bun-postgres on the text path (see the
         -- add_page_notes comment for the double-encode trap).
         SET notes = COALESCE(p.notes, '[]'::jsonb) || (${JSON.stringify(note)}::text)::jsonb
        FROM import_runs r
       WHERE p.id = ${input.importPageId}::uuid AND p.run_id = ${input.runId}::uuid
         AND r.id = p.run_id AND r.status = 'crawling'
      RETURNING p.id
    `)) as unknown as { id: string }[];
    return ok({ noted: rows.length > 0 });
  },
});

export const isCrawlingOp = defineOperation({
  name: "imports.is_crawling",
  readScope: "request",
  // Why system-only: see imports.claim_crawl. A crawl's job writes only
  // while its run is crawling.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId }).strict(),
  output: z.object({ crawling: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT 1 FROM import_runs WHERE id = ${input.runId}::uuid AND status = 'crawling'
    `)) as unknown as unknown[];
    return ok({ crawling: rows.length > 0 });
  },
});

export const failCrawlOp = defineOperation({
  name: "imports.fail_crawl",
  readScope: "request",
  // Why system-only: see imports.claim_crawl.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId, message: z.string().min(1).max(2000) }).strict(),
  output: z.object({ failed: z.boolean() }),
  handler: async (ctx, input, tx) => {
    // Only a crawling run: a run that ended (ready for review, cleaned up)
    // keeps what it has, whatever a late report says.
    const rows = (await tx.execute(sql`
      UPDATE import_runs
         SET status = 'failed', error_message = ${input.message},
             started_at = COALESCE(started_at, now()), finished_at = now(), heartbeat_at = NULL
       WHERE id = ${input.runId}::uuid AND status = 'crawling'
      RETURNING id
    `)) as unknown as { id: string }[];
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "imports.fail_crawl",
        input: { runId: input.runId },
        succeeded: true,
        entityId: input.runId,
        resultSummary: `crawl failed: ${input.message.slice(0, 200)}`,
      });
    }
    return ok({ failed: rows.length > 0 });
  },
});

export const saveCrawlCheckpointOp = defineOperation({
  name: "imports.save_crawl_checkpoint",
  readScope: "request",
  // Why system-only: see imports.claim_crawl.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId,
      /** The crawler's frontier (site-importer `CrawlCheckpoint`), checked by the job's report. */
      checkpoint: z.record(z.string(), z.unknown()),
    })
    .strict(),
  output: z.object({ saved: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE import_runs
         SET crawl_state = ${jsonbParam(input.checkpoint)}, heartbeat_at = now()
       WHERE id = ${input.runId}::uuid AND status = 'crawling'
      RETURNING id
    `)) as unknown as { id: string }[];
    return ok({ saved: rows.length > 0 });
  },
});

export const listCaptureTargetsOp = defineOperation({
  name: "imports.list_capture_targets",
  readScope: "request",
  // Why system-only: see imports.claim_crawl.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId,
      /** Only the pages the crawl stored no screenshot for (#423). */
      onlyMissingScreenshot: z.boolean(),
    })
    .strict(),
  output: z.object({
    pages: z.array(z.object({ importPageId: z.string(), sourceUrl: z.string() })),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, source_url
      FROM import_pages
      WHERE run_id = ${input.runId}::uuid
        ${input.onlyMissingScreenshot ? sql`AND screenshot_object_key IS NULL` : sql``}
      ORDER BY source_url
    `)) as unknown as { id: string; source_url: string }[];
    return ok({ pages: rows.map((r) => ({ importPageId: r.id, sourceUrl: r.source_url })) });
  },
});

export const finishCrawlOp = defineOperation({
  name: "imports.finish_crawl",
  readScope: "request",
  // Why system-only: see imports.claim_crawl.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId,
      pagesSeen: z.number().int().min(0),
      pagesExtracted: z.number().int().min(0),
      /**
       * What the run report keeps of the crawl (#197, #425): the error list,
       * the skip ledger and the out-of-scope count. The frontier itself is
       * no longer needed once the run left 'crawling'.
       */
      report: z
        .object({
          errors: z.array(z.object({ url: z.string(), reason: z.string() }).strict()),
          skipped: z.array(z.object({ url: z.string(), reason: z.string() }).strict()),
          skippedOutOfScope: z.number().int().min(0),
        })
        .strict(),
    })
    .strict(),
  output: z.object({ finished: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE import_runs
         SET status = 'ready_for_review', pages_seen = ${input.pagesSeen},
             pages_extracted = ${input.pagesExtracted}, error_message = NULL,
             started_at = COALESCE(started_at, now()), finished_at = now(),
             crawl_state = ${jsonbParam(input.report)}, heartbeat_at = NULL
       WHERE id = ${input.runId}::uuid AND status = 'crawling'
      RETURNING id
    `)) as unknown as { id: string }[];
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "imports.finish_crawl",
        input: { runId: input.runId, pagesSeen: input.pagesSeen },
        succeeded: true,
        entityId: input.runId,
        resultSummary: `crawled ${input.pagesExtracted} of ${input.pagesSeen} page(s), ${input.report.errors.length} error(s)`,
      });
    }
    return ok({ finished: rows.length > 0 });
  },
});

export const sweepUnstartedCrawlsOp = defineOperation({
  name: "imports.sweep_unstarted_crawls",
  readScope: "request",
  // Why system-only: the scheduler tick's backstop (#1360) — it finds the
  // crawls whose job was never started and starts them.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.object({ runIds: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    // A crawl whose start was lost (the request died right after it was
    // created or approved), and one a release before #1360 crawled
    // in-process — once that worker's heartbeat is stale.
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id
      FROM import_runs r
      WHERE r.status = 'crawling'
        AND (r.started_at IS NULL
             OR COALESCE(r.heartbeat_at, r.started_at)
                < now() - make_interval(mins => ${LEGACY_STALE_MINUTES}))
        AND NOT EXISTS (
          SELECT 1 FROM reporting_jobs j WHERE j.kind = 'site_import' AND j.subject_id = r.id
        )
      ORDER BY r.created_at
      LIMIT ${input.limit}
    `)) as unknown as { id: string }[];
    return ok({ runIds: rows.map((r) => r.id) });
  },
});
