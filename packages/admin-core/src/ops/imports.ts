// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — Site Import Wizard ops.
 *
 *  imports.list                    — open read; surfaces all runs.
 *  imports.get                     — open read; runs + per-page rows.
 *  imports.create_run              — Owner-direct; queues at status='crawling'.
 *  imports.propose_run             — AI propose (§11.A); queues at status='proposed'.
 *  imports.execute_proposal        — Owner approves an AI proposal → 'crawling'.
 *  imports.list_pending_proposals  — list status='proposed' for /security/import/pending.
 *  imports.reject_proposal         — Owner rejects an AI-proposed run.
 *  imports.accept_page             — Owner clicks Accept on a per-page row.
 *  imports.cleanup_run             — Owner-only; drops staging rows.
 *  imports.update_run_status       — system-only; worker calls when crawl
 *                                    flips ready_for_review / failed.
 *  imports.write_extracted_pages   — system-only; worker writes the
 *                                    crawler's per-URL extraction batch.
 */

import { defineOperation, OperationAbortError } from "@caelo-cms/query-api";
import {
  deriveModuleType,
  err,
  formatGenesisInventory,
  inventoryGenesisDraft,
  ok,
} from "@caelo-cms/shared";
import {
  flattenSiteDesignTokens,
  type PageDesignTokens,
  type SiteDesignTokens,
} from "@caelo-cms/site-importer";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { mapRowToOutput, toIso, toIsoRequired } from "./_helpers.js";
import { resolveChatSessionId } from "./_propose-helpers.js";
import { updateThemeTokensOp } from "./themes.js";

const runStatus = z.enum(["proposed", "crawling", "ready_for_review", "completed", "failed"]);

// issue #247 (WS1) — Zod at the WRITE boundary for sampled design
// tokens. The shapes mirror @caelo-cms/site-importer's PageDesignTokens
// / SiteDesignTokens; the z.ZodType annotations make drift a compile
// error. Read surfaces expose the stored jsonb as z.unknown() (same
// precedent as import_runs.estimate) so a schema evolution never bricks
// list/get.
const tokenFrequency = z.object({ value: z.string().max(500), count: z.number().int().min(1) });
const pageDesignTokensSchema: z.ZodType<PageDesignTokens> = z.object({
  palette: z.array(tokenFrequency).max(16),
  backgrounds: z.array(tokenFrequency).max(16),
  fontFamilies: z.array(tokenFrequency).max(16),
  fontSizes: z.array(tokenFrequency).max(16),
  fontWeights: z.array(tokenFrequency).max(16),
  radii: z.array(tokenFrequency).max(16),
  shadows: z.array(tokenFrequency).max(16),
  roles: z.record(z.string(), z.record(z.string(), z.string().max(500))),
});
const siteDesignTokensSchema: z.ZodType<SiteDesignTokens> = z.object({
  palette: z.array(tokenFrequency).max(16),
  backgrounds: z.array(tokenFrequency).max(16),
  fontFamilies: z.array(tokenFrequency).max(16),
  fontSizes: z.array(tokenFrequency).max(16),
  fontWeights: z.array(tokenFrequency).max(16),
  radii: z.array(tokenFrequency).max(16),
  shadows: z.array(tokenFrequency).max(16),
  roles: z.record(z.string(), z.record(z.string(), z.string().max(500))),
  pageCount: z.number().int().min(0),
});

/** jsonb columns may come back decoded or as a JSON string depending on
 *  the SQL client path — normalise like `estimate` does. */
function parseJsonbColumn(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : (raw ?? null);
}

const runRow = z.object({
  id: z.string(),
  sourceUrl: z.string(),
  depth: z.number(),
  maxPages: z.number(),
  status: runStatus,
  proposedBy: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  pagesSeen: z.number(),
  pagesExtracted: z.number(),
  errorMessage: z.string().nullable(),
  /** 0124 — originating chat session; null for Owner-direct runs. The
   *  chat's crawl-status endpoint uses it to scope reads per chat. */
  chatSessionId: z.string().nullable(),
  /** issue #193 — crawl-scope estimate ({pages, basis, crawlMinutes,
   *  aiCostUsd} or {failed, reason}); null on Owner-direct runs. */
  estimate: z.unknown().nullable(),
  createdAt: z.string(),
});

const pageRow = z.object({
  id: z.string(),
  runId: z.string(),
  sourceUrl: z.string(),
  proposedSlug: z.string(),
  proposedTitle: z.string(),
  proposedModules: z.array(
    z.object({
      blockName: z.string(),
      position: z.number(),
      html: z.string(),
      displayName: z.string(),
    }),
  ),
  proposedThemeTokens: z.record(z.string(), z.string()),
  /** issue #194 — structural signature + current cluster + AI label. */
  structuralSignature: z.string().nullable(),
  clusterKey: z.string().nullable(),
  clusterLabel: z.string().nullable(),
  screenshotObjectKey: z.string().nullable(),
  stagedScreenshotObjectKey: z.string().nullable(),
  diffStatus: z.enum(["pass", "warn", "fail"]).nullable(),
  diffPct: z.number().nullable(),
  /** issue #247 — computed-style token summary sampled in the same
   *  render pass as the source screenshot; null = never sampled
   *  (fetch-only crawl or capture failure — see screenshot_missing /
   *  design_tokens_missing notes). Read as unknown (estimate
   *  precedent); the write op validates the strict shape. */
  sampledDesignTokens: z.unknown().nullable(),
  acceptedPageId: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  createdAt: z.string(),
});

interface RunDb {
  id: string;
  source_url: string;
  depth: number;
  max_pages: number;
  status: z.infer<typeof runStatus>;
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | Date | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  pages_seen: number;
  pages_extracted: number;
  error_message: string | null;
  chat_session_id?: string | null;
  estimate: unknown;
  created_at: string | Date;
}

function toRunApi(r: RunDb): z.infer<typeof runRow> {
  return mapRowToOutput(r, runRow, (row) => ({
    id: row.id,
    sourceUrl: row.source_url,
    depth: row.depth,
    maxPages: row.max_pages,
    status: row.status,
    proposedBy: row.proposed_by,
    approvedBy: row.approved_by,
    approvedAt: toIso(row.approved_at),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    pagesSeen: row.pages_seen,
    pagesExtracted: row.pages_extracted,
    errorMessage: row.error_message,
    chatSessionId: row.chat_session_id ?? null,
    estimate: typeof row.estimate === "string" ? JSON.parse(row.estimate) : (row.estimate ?? null),
    createdAt: toIsoRequired(row.created_at, "import_runs.created_at"),
  }));
}

export const listImportRunsOp = defineOperation({
  name: "imports.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      status: runStatus.optional(),
    })
    .strict(),
  output: z.object({ runs: z.array(runRow) }),
  handler: async (_ctx, input, tx) => {
    const filter = input.status ? sql`WHERE status = ${input.status}` : sql.raw("");
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, source_url, depth, max_pages, status,
             proposed_by::text AS proposed_by, approved_by::text AS approved_by,
             approved_at, started_at, finished_at, pages_seen, pages_extracted, estimate, chat_session_id::text AS chat_session_id,
             error_message, created_at
      FROM import_runs
      ${filter}
      ORDER BY created_at DESC
      LIMIT 200
    `)) as unknown as RunDb[];
    return ok({ runs: rows.map(toRunApi) });
  },
});

export const getImportRunOp = defineOperation({
  name: "imports.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({
    run: runRow.nullable(),
    pages: z.array(pageRow),
  }),
  handler: async (_ctx, input, tx) => {
    const runs = (await tx.execute(sql`
      SELECT id::text AS id, source_url, depth, max_pages, status,
             proposed_by::text AS proposed_by, approved_by::text AS approved_by,
             approved_at, started_at, finished_at, pages_seen, pages_extracted, estimate, chat_session_id::text AS chat_session_id,
             error_message, created_at
      FROM import_runs WHERE id = ${input.runId}::uuid LIMIT 1
    `)) as unknown as RunDb[];
    const run = runs[0] ? toRunApi(runs[0]) : null;
    const pageRows = (await tx.execute(sql`
      SELECT id::text AS id, run_id::text AS run_id, source_url,
             proposed_slug, proposed_title, proposed_modules, proposed_theme_tokens,
             structural_signature, cluster_key, cluster_label,
             screenshot_object_key, staged_screenshot_object_key, diff_status, diff_pct,
             sampled_design_tokens,
             accepted_page_id::text AS accepted_page_id, accepted_at, rejected_at, created_at
      FROM import_pages
      WHERE run_id = ${input.runId}::uuid
      ORDER BY created_at ASC
    `)) as unknown as Array<{
      id: string;
      run_id: string;
      source_url: string;
      proposed_slug: string;
      proposed_title: string;
      proposed_modules: Array<{
        blockName: string;
        position: number;
        html: string;
        displayName: string;
      }>;
      proposed_theme_tokens: Record<string, string>;
      structural_signature: string | null;
      cluster_key: string | null;
      cluster_label: string | null;
      screenshot_object_key: string | null;
      staged_screenshot_object_key: string | null;
      diff_status: "pass" | "warn" | "fail" | null;
      diff_pct: number | null;
      sampled_design_tokens: unknown;
      accepted_page_id: string | null;
      accepted_at: string | Date | null;
      rejected_at: string | Date | null;
      created_at: string | Date;
    }>;
    return ok({
      run,
      pages: pageRows.map((p) => ({
        id: p.id,
        runId: p.run_id,
        sourceUrl: p.source_url,
        proposedSlug: p.proposed_slug,
        proposedTitle: p.proposed_title,
        proposedModules: p.proposed_modules ?? [],
        proposedThemeTokens: p.proposed_theme_tokens ?? {},
        structuralSignature: p.structural_signature,
        clusterKey: p.cluster_key,
        clusterLabel: p.cluster_label,
        screenshotObjectKey: p.screenshot_object_key,
        stagedScreenshotObjectKey: p.staged_screenshot_object_key,
        diffStatus: p.diff_status,
        diffPct: p.diff_pct,
        sampledDesignTokens: parseJsonbColumn(p.sampled_design_tokens),
        acceptedPageId: p.accepted_page_id,
        acceptedAt: p.accepted_at
          ? p.accepted_at instanceof Date
            ? p.accepted_at.toISOString()
            : String(p.accepted_at)
          : null,
        rejectedAt: p.rejected_at
          ? p.rejected_at instanceof Date
            ? p.rejected_at.toISOString()
            : String(p.rejected_at)
          : null,
        createdAt: p.created_at instanceof Date ? p.created_at.toISOString() : String(p.created_at),
      })),
    });
  },
});

export const createImportRunOp = defineOperation({
  name: "imports.create_run",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      sourceUrl: z.string().url(),
      depth: z.number().int().min(1).max(5).default(2),
      maxPages: z.number().int().min(1).max(2000).default(50),
    })
    .strict(),
  output: z.object({ runId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO import_runs (source_url, depth, max_pages, status, proposed_by, approved_by, approved_at)
      VALUES (
        ${input.sourceUrl}, ${input.depth}, ${input.maxPages}, 'crawling',
        ${ctx.actorId}::uuid, ${ctx.actorId}::uuid, now()
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "imports.create_run",
        message: "no row returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.create_run",
      input,
      succeeded: true,
      resultSummary: `crawl ${input.sourceUrl} depth=${input.depth} max=${input.maxPages}`,
    });
    return ok({ runId: id });
  },
});

export const proposeImportRunOp = defineOperation({
  name: "imports.propose_run",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      sourceUrl: z.string().url(),
      depth: z.number().int().min(1).max(5).default(2),
      maxPages: z.number().int().min(1).max(2000).default(50),
      /** issue #193 — computed by the proposing tool BEFORE this op
       *  (network work stays out of the DB tx). Stored verbatim for
       *  the Owner queue; {failed, reason} is a valid value. */
      estimate: z
        .union([
          z
            .object({
              pages: z.number().int().min(0),
              basis: z.enum(["sitemap", "sample"]),
              truncated: z.boolean(),
              crawlMinutes: z.number().min(0),
              aiCostUsd: z.object({ low: z.number().min(0), high: z.number().min(0) }),
            })
            .strict(),
          z.object({ failed: z.literal(true), reason: z.string().max(1000) }).strict(),
        ])
        .nullable()
        .optional(),
    })
    .strict(),
  output: z.object({ runId: z.string() }),
  handler: async (ctx, input, tx) => {
    // 0124 — record the originating chat so the chat's pending strip
    // (pending_proposals.list, filtered per session) can surface this
    // run's Approve button pinned above the composer.
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
    const rows = (await tx.execute(sql`
      INSERT INTO import_runs (source_url, depth, max_pages, status, proposed_by, estimate, chat_session_id)
      VALUES (${input.sourceUrl}, ${input.depth}, ${input.maxPages}, 'proposed', ${ctx.actorId}::uuid,
              ${jsonbParam(input.estimate ? input.estimate : null)},
              ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "imports.propose_run",
        message: "no row returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.propose_run",
      input,
      succeeded: true,
      resultSummary: `proposed crawl ${input.sourceUrl}`,
    });
    return ok({ runId: id });
  },
});

export const listPendingImportProposalsOp = defineOperation({
  name: "imports.list_pending_proposals",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ runs: z.array(runRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, source_url, depth, max_pages, status,
             proposed_by::text AS proposed_by, approved_by::text AS approved_by,
             approved_at, started_at, finished_at, pages_seen, pages_extracted, estimate, chat_session_id::text AS chat_session_id,
             error_message, created_at
      FROM import_runs
      WHERE status = 'proposed'
      ORDER BY created_at DESC
      LIMIT 100
    `)) as unknown as RunDb[];
    return ok({ runs: rows.map(toRunApi) });
  },
});

export const executeImportProposalOp = defineOperation({
  name: "imports.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE import_runs
         SET status = 'crawling', approved_by = ${ctx.actorId}::uuid, approved_at = now()
       WHERE id = ${input.runId}::uuid AND status = 'proposed'
       RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "imports.execute_proposal",
        message: "proposal not found or not in proposed status",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.execute_proposal",
      input,
      succeeded: true,
      resultSummary: `approved import run ${input.runId}`,
    });
    return ok({});
  },
});

export const rejectImportProposalOp = defineOperation({
  name: "imports.reject_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid(), reason: z.string().max(500).optional() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE import_runs
         SET status = 'failed', error_message = ${input.reason ?? "rejected by Owner"},
             finished_at = now()
       WHERE id = ${input.runId}::uuid AND status = 'proposed'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.reject_proposal",
      input,
      succeeded: true,
      resultSummary: `rejected ${input.runId}`,
    });
    return ok({});
  },
});

export const updateImportRunStatusOp = defineOperation({
  name: "imports.update_run_status",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      status: z.enum(["crawling", "ready_for_review", "failed"]),
      pagesSeen: z.number().int().min(0).optional(),
      pagesExtracted: z.number().int().min(0).optional(),
      errorMessage: z.string().max(2000).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE import_runs
         SET status = ${input.status},
             pages_seen = COALESCE(${input.pagesSeen ?? null}, pages_seen),
             pages_extracted = COALESCE(${input.pagesExtracted ?? null}, pages_extracted),
             error_message = ${input.errorMessage ?? null},
             started_at = COALESCE(started_at, now()),
             finished_at = CASE WHEN ${input.status} IN ('ready_for_review','failed')
                                 THEN now() ELSE finished_at END
       WHERE id = ${input.runId}::uuid
    `);
    return ok({});
  },
});

/**
 * P14 polish — Owner acknowledges a `fail`-classified screenshot diff
 * so the page becomes accept-able. AI cannot ack — actorScope is
 * human + system only, matching the §11.A "hard-to-revert" pattern
 * (publishing a misrendered page silently is hard to spot post-hoc).
 */
export const acknowledgeImportPageDiffOp = defineOperation({
  name: "imports.acknowledge_page_diff",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ importPageId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE import_pages
         SET acknowledged_by = ${ctx.actorId}::uuid, acknowledged_at = now()
       WHERE id = ${input.importPageId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.acknowledge_page_diff",
      input,
      succeeded: true,
      resultSummary: `acked diff on import_page ${input.importPageId}`,
    });
    return ok({});
  },
});

/**
 * P14 polish — worker writes per-page screenshot diff result. Wired
 * by the orchestrator after Playwright captures source + staged
 * renders + computePixelDiff classifies them. NULL diff_status (no
 * screenshot taken) does NOT block accept; only `fail` does, gated
 * by Owner acknowledgement at /security/import/[runId].
 */
export const updatePageDiffOp = defineOperation({
  name: "imports.update_page_diff",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      importPageId: z.string().uuid(),
      diffStatus: z.enum(["pass", "warn", "fail"]),
      diffPct: z.number().min(0).max(1),
      screenshotObjectKey: z.string().max(500).optional(),
      /** issue #198 — the rebuilt (staged preview) capture's key. */
      stagedScreenshotObjectKey: z.string().max(500).optional(),
      /** issue #247 — per-page computed-style token summary, sampled
       *  in the same render session as the source screenshot. */
      sampledDesignTokens: pageDesignTokensSchema.optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE import_pages
         SET diff_status = ${input.diffStatus},
             diff_pct = ${input.diffPct},
             screenshot_object_key = COALESCE(${input.screenshotObjectKey ?? null}, screenshot_object_key),
             staged_screenshot_object_key = COALESCE(${input.stagedScreenshotObjectKey ?? null}, staged_screenshot_object_key),
             -- (::text)::jsonb keeps bun-postgres on the text path (see
             -- the add_page_notes comment for the double-encode trap).
             sampled_design_tokens = COALESCE(
               (${input.sampledDesignTokens ? JSON.stringify(input.sampledDesignTokens) : null}::text)::jsonb,
               sampled_design_tokens
             )
       WHERE id = ${input.importPageId}::uuid
    `);
    return ok({});
  },
});

/**
 * issue #247 — worker writes the run-level design-token aggregate after
 * the per-page ground-truth captures. `imports.compose_from_run`
 * prefers this over the extractor's inline-CSS-derived tokens because
 * computed styles are what the browser actually rendered.
 */
export const setRunDesignTokensOp = defineOperation({
  name: "imports.set_run_design_tokens",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      siteDesignTokens: siteDesignTokensSchema,
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE import_runs
         SET site_design_tokens = (${JSON.stringify(input.siteDesignTokens)}::text)::jsonb
       WHERE id = ${input.runId}::uuid
       RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "imports.set_run_design_tokens",
        message: "import run not found",
      });
    }
    return ok({});
  },
});

/**
 * issue #198 — screenshot keys for ONE import page. Powers the
 * authenticated serve route and the AI's look-at-the-original tool
 * without dragging the whole run through imports.get.
 */
export const getImportPageScreenshotKeysOp = defineOperation({
  name: "imports.get_page_screenshot_keys",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ importPageId: z.string().uuid() }).strict(),
  output: z.object({
    sourceUrl: z.string().nullable(),
    screenshotObjectKey: z.string().nullable(),
    stagedScreenshotObjectKey: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT source_url, screenshot_object_key, staged_screenshot_object_key
      FROM import_pages WHERE id = ${input.importPageId}::uuid LIMIT 1
    `)) as unknown as Array<{
      source_url: string;
      screenshot_object_key: string | null;
      staged_screenshot_object_key: string | null;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "imports.get_page_screenshot_keys",
        message: "import page not found — list the run with imports.get for valid page ids",
      });
    }
    return ok({
      sourceUrl: r.source_url,
      screenshotObjectKey: r.screenshot_object_key,
      stagedScreenshotObjectKey: r.staged_screenshot_object_key,
    });
  },
});

/**
 * issue #250 (WS4) — everything the fidelity verdict tool needs to grade one
 * rebuilt page, resolved from EITHER id the AI is holding: the staging
 * `import_pages.id` OR the composed `pages.id` it just built
 * (accepted_page_id). Mirrors `imports.add_page_notes`' dual-id ergonomics so
 * the AI never has to look one id up from the other mid-flow.
 *
 * Returns the source screenshot key (null = UNVERIFIED — no ground truth to
 * diff against) and the accepted page id (null = not composed yet) so the
 * tool can fail loudly + specifically instead of guessing.
 */
export const getImportPageFidelityInputsOp = defineOperation({
  name: "imports.get_page_fidelity_inputs",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ pageRef: z.string().uuid() }).strict(),
  output: z.object({
    importPageId: z.string(),
    sourceUrl: z.string().nullable(),
    screenshotObjectKey: z.string().nullable(),
    acceptedPageId: z.string().nullable(),
    diffStatus: z.enum(["pass", "warn", "fail"]).nullable(),
    diffPct: z.number().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, source_url, screenshot_object_key,
             accepted_page_id::text AS accepted_page_id, diff_status, diff_pct
      FROM import_pages
      WHERE id = ${input.pageRef}::uuid OR accepted_page_id = ${input.pageRef}::uuid
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      source_url: string | null;
      screenshot_object_key: string | null;
      accepted_page_id: string | null;
      diff_status: "pass" | "warn" | "fail" | null;
      diff_pct: number | null;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "imports.get_page_fidelity_inputs",
        message:
          "no import page matches this id — pass EITHER the staging import_pages id OR the composed page id (accepted_page_id); list the run with imports.get for valid ids",
      });
    }
    return ok({
      importPageId: r.id,
      sourceUrl: r.source_url,
      screenshotObjectKey: r.screenshot_object_key,
      acceptedPageId: r.accepted_page_id,
      diffStatus: r.diff_status,
      diffPct: r.diff_pct,
    });
  },
});

export const writeExtractedPagesOp = defineOperation({
  name: "imports.write_extracted_pages",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      pages: z
        .array(
          z.object({
            sourceUrl: z.string().url(),
            proposedSlug: z.string().min(1).max(120),
            proposedTitle: z.string().max(500),
            proposedModules: z.array(
              z.object({
                blockName: z.string(),
                position: z.number(),
                html: z.string(),
                displayName: z.string(),
              }),
            ),
            proposedThemeTokens: z.record(z.string(), z.string()),
            /** issue #194 — crawler-computed structural signature. */
            signature: z.string().max(200).optional(),
            /** issue #195 — the page's <style> contents. */
            pageCss: z.string().max(600_000).optional(),
            /** run #10 D3 — comment-thread subtrees the extractor removed.
             *  Persisted as a loud `comments_stripped` note; never silent. */
            commentsStripped: z.number().int().min(0).optional(),
          }),
        )
        .max(500),
    })
    .strict(),
  output: z.object({ inserted: z.number() }),
  handler: async (_ctx, input, tx) => {
    let inserted = 0;
    for (const p of input.pages) {
      // run #10 D3 — the extractor's comment-thread stripper reports a
      // count; store it as a system note in the same shape the AI's
      // add_page_notes uses so get_run_report rolls it up per category.
      const notes =
        p.commentsStripped !== undefined && p.commentsStripped > 0
          ? [
              {
                category: "comments_stripped" as const,
                note: `comments-stripped:${p.commentsStripped} — comment-thread markup (WP #comments/.comment-list/#respond or builder equivalent) removed at extraction`,
                applied: true,
              },
            ]
          : null;
      const r = (await tx.execute(sql`
        INSERT INTO import_pages (
          run_id, source_url, proposed_slug, proposed_title,
          proposed_modules, proposed_theme_tokens,
          structural_signature, cluster_key, page_css, notes
        ) VALUES (
          ${input.runId}::uuid, ${p.sourceUrl}, ${p.proposedSlug}, ${p.proposedTitle},
          ${jsonbParam(p.proposedModules)},
          ${jsonbParam(p.proposedThemeTokens)},
          ${p.signature ?? null}, ${p.signature ?? null}, ${p.pageCss ?? null},
          ${jsonbParam(notes)}
        )
        ON CONFLICT (run_id, source_url) DO NOTHING
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      if (r.length > 0) inserted += 1;
    }
    return ok({ inserted });
  },
});

/**
 * P14 — Owner clicks Accept on an import_pages row. Promotes the
 * staged content into a real `pages` row with status='draft'. Modules
 * are inserted as new `modules` rows + linked via `page_modules`.
 *
 * Does NOT publish — promoted page stays at status='draft' so the
 * standard preview→publish flow is unchanged.
 */
export const acceptImportedPageOp = defineOperation({
  name: "imports.accept_page",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      importPageId: z.string().uuid(),
      templateId: z.string().uuid(),
      layoutId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({ pageId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT proposed_slug, proposed_title, proposed_modules, accepted_page_id,
             diff_status, acknowledged_at
      FROM import_pages WHERE id = ${input.importPageId}::uuid LIMIT 1
    `)) as unknown as Array<{
      proposed_slug: string;
      proposed_title: string;
      // jsonb may come back as an already-decoded array OR a JSON
      // string depending on the underlying SQL client + the way the
      // column was written. Normalise via the same conditional idiom
      // locales.ts uses for its preview/payload jsonb columns.
      proposed_modules: unknown;
      accepted_page_id: string | null;
      diff_status: "pass" | "warn" | "fail" | null;
      acknowledged_at: string | Date | null;
    }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "imports.accept_page",
        message: "import_page not found",
      });
    }
    if (r.accepted_page_id) {
      return err({
        kind: "HandlerError",
        operation: "imports.accept_page",
        message: "already accepted",
      });
    }
    // P14 plan — failed screenshot diff requires explicit Owner ack
    // before the page can be promoted to a real `pages` row. NULL
    // diff_status (no screenshot taken) is non-blocking.
    if (r.diff_status === "fail" && !r.acknowledged_at) {
      return err({
        kind: "HandlerError",
        operation: "imports.accept_page",
        message:
          "screenshot diff failed for this page; acknowledge it at /security/import/<runId> before accepting",
      });
    }
    const proposedModules = (
      typeof r.proposed_modules === "string" ? JSON.parse(r.proposed_modules) : r.proposed_modules
    ) as Array<{
      blockName: string;
      position: number;
      html: string;
      displayName: string;
    }>;
    // Insert the page row.
    const pageRows = (await tx.execute(sql`
      INSERT INTO pages (slug, locale, title, name, status, template_id, version)
      VALUES (
        ${r.proposed_slug}, 'en',
        ${r.proposed_title || r.proposed_slug},
        ${r.proposed_title || r.proposed_slug},
        'draft', ${input.templateId}::uuid, 1
      )
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    const pageId = pageRows[0]?.id;
    if (!pageId) {
      return err({
        kind: "HandlerError",
        operation: "imports.accept_page",
        message: "page insert returned no id",
      });
    }
    // Insert modules + page_modules per extracted module.
    // issue #253 — header/footer are layout-owned chrome; compose_from_run
    // binds them once at the layout. A per-page accept never mints
    // per-page chrome placements (the imported templates carry no
    // header/footer blocks anymore, so such rows would be invisible).
    for (const m of proposedModules.filter(
      (pm) => pm.blockName !== "header" && pm.blockName !== "footer",
    )) {
      const modRows = (await tx.execute(sql`
        INSERT INTO modules (slug, display_name, type, html, css, js)
        VALUES (
          ${`imported-${pageId.slice(0, 8)}-${m.blockName}-${m.position}`},
          ${m.displayName}, ${deriveModuleType(m.displayName)}, ${m.html}, '', ''
        )
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const moduleId = modRows[0]?.id;
      if (!moduleId) continue;
      // v0.12.0 — mint a fresh unsynced content_instance per placement
      // so page_modules.content_instance_id NOT NULL is satisfied.
      const ciRow = (await tx.execute(sql`
        INSERT INTO content_instances (module_id, "values")
        VALUES (${moduleId}::uuid, '{}'::jsonb)
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const newCiId = ciRow[0]?.id;
      if (!newCiId) continue;
      await tx.execute(sql`
        INSERT INTO page_modules
          (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (
          ${pageId}::uuid,
          ${m.blockName},
          ${m.position},
          ${moduleId}::uuid,
          ${newCiId}::uuid,
          'unsynced'
        )
      `);
    }
    await tx.execute(sql`
      UPDATE import_pages
         SET accepted_page_id = ${pageId}::uuid, accepted_at = now()
       WHERE id = ${input.importPageId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.accept_page",
      input,
      succeeded: true,
      resultSummary: `promoted ${r.proposed_slug} → page ${pageId}`,
    });
    return ok({ pageId });
  },
});

/**
 * issue #194 — page-type clusters over a crawled run. The crawler
 * computed deterministic structural signatures; this read groups the
 * run's pages by their CURRENT cluster_key so the AI can present
 * "45 pages look like blog posts" and the operator confirms in chat.
 * Open to all actor kinds per §11 (broad read plans good writes).
 */
export const listImportPageClustersOp = defineOperation({
  name: "imports.list_page_clusters",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({
    clusters: z.array(
      z.object({
        clusterKey: z.string(),
        label: z.string().nullable(),
        count: z.number(),
        samples: z.array(
          z.object({
            importPageId: z.string(),
            sourceUrl: z.string(),
            proposedTitle: z.string(),
            proposedSlug: z.string(),
          }),
        ),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, source_url, proposed_title, proposed_slug,
             COALESCE(cluster_key, structural_signature, 'unclustered') AS cluster_key,
             cluster_label
      FROM import_pages
      WHERE run_id = ${input.runId}::uuid
      ORDER BY created_at ASC
    `)) as unknown as Array<{
      id: string;
      source_url: string;
      proposed_title: string;
      proposed_slug: string;
      cluster_key: string;
      cluster_label: string | null;
    }>;
    const byKey = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byKey.get(r.cluster_key) ?? [];
      list.push(r);
      byKey.set(r.cluster_key, list);
    }
    const clusters = [...byKey.entries()]
      .map(([clusterKey, members]) => ({
        clusterKey,
        label: members.find((m) => m.cluster_label)?.cluster_label ?? null,
        count: members.length,
        samples: members.slice(0, 5).map((m) => ({
          importPageId: m.id,
          sourceUrl: m.source_url,
          proposedTitle: m.proposed_title,
          proposedSlug: m.proposed_slug,
        })),
      }))
      // Largest first; "home" pinned to the front — it is the design
      // contract and the AI presents it first.
      .sort((a, b) =>
        a.clusterKey === "home" ? -1 : b.clusterKey === "home" ? 1 : b.count - a.count,
      );
    return ok({ clusters });
  },
});

/**
 * issue #194 — bulk cluster re-assignment + labelling in ONE tx (§11:
 * the AI posts a multi-row change as one call). Two shapes, both
 * optional but at least one required:
 *   - importPageIds → move those pages into clusterKey;
 *   - label → set the human name on every page currently in clusterKey.
 */
export const assignImportPageClusterOp = defineOperation({
  name: "imports.assign_page_cluster",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      clusterKey: z.string().min(1).max(200),
      importPageIds: z.array(z.string().uuid()).max(2000).optional(),
      label: z.string().min(1).max(120).optional(),
    })
    .strict()
    .refine((v) => (v.importPageIds && v.importPageIds.length > 0) || v.label !== undefined, {
      message: "pass importPageIds (re-assign), label (name the cluster), or both",
    }),
  output: z.object({ reassigned: z.number(), labelled: z.number() }),
  handler: async (ctx, input, tx) => {
    let reassigned = 0;
    if (input.importPageIds && input.importPageIds.length > 0) {
      // Zod validated each id as a UUID, so the raw ARRAY literal is
      // injection-safe (same pattern as pages.delete_many).
      const idArray = `ARRAY[${input.importPageIds.map((id) => `'${id}'::uuid`).join(",")}]`;
      const moved = (await tx.execute(sql`
        UPDATE import_pages
        SET cluster_key = ${input.clusterKey}
        WHERE run_id = ${input.runId}::uuid
          AND id = ANY(${sql.raw(idArray)})
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      reassigned = moved.length;
      if (reassigned !== input.importPageIds.length) {
        return err({
          kind: "HandlerError",
          operation: "imports.assign_page_cluster",
          message: `only ${reassigned}/${input.importPageIds.length} pages matched this run — re-list with list_page_clusters and retry with valid importPageIds`,
        });
      }
    }
    let labelled = 0;
    if (input.label !== undefined) {
      const named = (await tx.execute(sql`
        UPDATE import_pages
        SET cluster_label = ${input.label}
        WHERE run_id = ${input.runId}::uuid AND cluster_key = ${input.clusterKey}
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      labelled = named.length;
      if (labelled === 0) {
        return err({
          kind: "HandlerError",
          operation: "imports.assign_page_cluster",
          message: `no pages in cluster '${input.clusterKey}' for this run — check list_page_clusters for valid keys`,
        });
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.assign_page_cluster",
      input,
      succeeded: true,
      resultSummary: `cluster ${input.clusterKey}: reassigned=${reassigned} labelled=${labelled}`,
    });
    return ok({ reassigned, labelled });
  },
});

// issue #247 — `screenshot_missing` / `design_tokens_missing` are
// SYSTEM-written by the orchestrator's ground-truth capture pass (a
// page without a source screenshot is UNVERIFIED, loudly — CLAUDE.md §2
// no-fallbacks). The AI-facing add_import_page_notes tool deliberately
// keeps the original five: the model reports content findings, it never
// asserts capture state.
// run #10 D3 — `comments_stripped` is SYSTEM-written at extraction time
// (imports.write_extracted_pages) when the crawler removed WordPress
// comment-thread markup; like the #247 capture notes it never comes
// from the AI tool.
const noteCategory = z.enum([
  "typo",
  "dead_link",
  "missing_alt",
  "thin_content",
  "improvement",
  "screenshot_missing",
  "design_tokens_missing",
  "comments_stripped",
]);

/**
 * issue #197 — record findings made while rebuilding a page. Bulk per
 * page (§11: one call, one tx); notes APPEND to what's already there
 * so multiple passes (content rebuild, then a11y sweep) accumulate.
 *
 * issue #263 — `importPageId` accepts EITHER the `import_pages.id`
 * (staging row) OR the `import_pages.accepted_page_id` (the composed
 * CMS `pages.id` that accept_page / compose_from_run minted). Both are
 * uuids and the AI naturally reaches for the CMS page id it just built,
 * so the handler resolves both against one row inside the tx rather
 * than forcing the model to round-trip through imports.get (CLAUDE.md
 * §1A — enrich the surface so the AI doesn't have to ask).
 */
export const addImportPageNotesOp = defineOperation({
  name: "imports.add_page_notes",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Either the staging `import_pages.id` OR the composed CMS
       *  `pages.id` (== `import_pages.accepted_page_id`); the handler
       *  resolves either form to the owning import_pages row (#263). */
      importPageId: z.string().uuid(),
      notes: z
        .array(
          z
            .object({
              category: noteCategory,
              note: z.string().min(1).max(1000),
              /** true = the AI fixed it during the rebuild; false = suggested only. */
              applied: z.boolean(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
  output: z.object({ totalNotes: z.number().int() }),
  handler: async (ctx, input, tx) => {
    // #263 — resolve the given id against BOTH the staging id and the
    // accepted CMS page id, preferring a direct import_pages.id match
    // (the `ORDER BY … DESC` pins it first when a value could somehow
    // match both id spaces). One statement keeps the resolve + write in
    // the same tx.
    const rows = (await tx.execute(sql`
      WITH target AS (
        SELECT id
        FROM import_pages
        WHERE id = ${input.importPageId}::uuid
           OR accepted_page_id = ${input.importPageId}::uuid
        ORDER BY (id = ${input.importPageId}::uuid) DESC
        LIMIT 1
      )
      UPDATE import_pages ip
      -- (::text)::jsonb, not ::jsonb: bun-postgres infers a jsonb
      -- parameter type from the direct cast and double-encodes the
      -- string, turning the array into ONE jsonb string element.
      -- Forcing the text path keeps it an array. (INSERT targets
      -- coerce via the column type and don't hit this.)
      SET notes = COALESCE(ip.notes, '[]'::jsonb) || (${JSON.stringify(input.notes)}::text)::jsonb
      FROM target
      WHERE ip.id = target.id
      RETURNING jsonb_array_length(ip.notes) AS total
    `)) as unknown as Array<{ total: number }>;
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "imports.add_page_notes",
        message:
          "import page not found — importPageId accepts either the staging import_pages.id OR the composed CMS page id (import_pages.accepted_page_id); list the run with imports.get to see both ids per page",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.add_page_notes",
      input,
      succeeded: true,
      resultSummary: `+${input.notes.length} notes (total ${r.total})`,
    });
    return ok({ totalNotes: r.total });
  },
});

/**
 * issue #197 — the run-level rollup the migration CLOSES with: pages
 * per confirmed type, redirects created, crawl fetch errors (#192
 * checkpoints them), and the AI's notes grouped by category with
 * applied/suggested split. One read; the skill turns it into the
 * plain-words closing message.
 */
export const getImportRunReportOp = defineOperation({
  name: "imports.get_run_report",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({
    sourceUrl: z.string(),
    status: runStatus,
    pagesSeen: z.number(),
    pagesExtracted: z.number(),
    acceptedPages: z.number(),
    clusters: z.array(
      z.object({ clusterKey: z.string(), label: z.string().nullable(), count: z.number() }),
    ),
    redirectsCreated: z.number(),
    crawlErrors: z.array(z.object({ url: z.string(), reason: z.string() })),
    /** issue #247 — pages with NO source screenshot. Each also carries
     *  a screenshot_missing note; downstream verification (WS4) treats
     *  them as UNVERIFIED. */
    pagesMissingScreenshot: z.number(),
    /** issue #250 (WS4) — source-vs-rebuilt fidelity rollup. `unverified`
     *  counts composed pages that have a source screenshot but no computed
     *  diff yet (verify_import_page_fidelity never ran) PLUS pages missing a
     *  source screenshot — both mean "nothing measured this rebuild".
     *  `overThreshold` lists the warn/fail pages the report must surface so
     *  the AI never says "fertig" over red pages. */
    fidelity: z.object({
      pass: z.number(),
      warn: z.number(),
      fail: z.number(),
      unverified: z.number(),
      overThreshold: z.array(
        z.object({
          sourceUrl: z.string(),
          diffStatus: z.enum(["warn", "fail"]),
          diffPct: z.number(),
        }),
      ),
    }),
    /** issue #247 — the site-level computed-style token aggregate;
     *  null when the run never got a Playwright render pass. */
    siteDesignTokens: z.unknown().nullable(),
    notes: z.array(
      z.object({
        category: noteCategory,
        applied: z.number(),
        suggested: z.number(),
        samples: z.array(
          z.object({ sourceUrl: z.string(), note: z.string(), applied: z.boolean() }),
        ),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const runRows = (await tx.execute(sql`
      SELECT source_url, status, pages_seen, pages_extracted, crawl_state, site_design_tokens
      FROM import_runs WHERE id = ${input.runId}::uuid LIMIT 1
    `)) as unknown as Array<{
      source_url: string;
      status: z.infer<typeof runStatus>;
      pages_seen: number;
      pages_extracted: number;
      crawl_state: unknown;
      site_design_tokens: unknown;
    }>;
    const run = runRows[0];
    if (!run) {
      return err({
        kind: "HandlerError",
        operation: "imports.get_run_report",
        message: "import run not found",
      });
    }
    const pages = (await tx.execute(sql`
      SELECT source_url, proposed_slug, accepted_page_id, screenshot_object_key,
             diff_status, diff_pct,
             COALESCE(cluster_key, structural_signature, 'content') AS cluster_key,
             cluster_label, notes
      FROM import_pages WHERE run_id = ${input.runId}::uuid
      ORDER BY created_at ASC
    `)) as unknown as Array<{
      source_url: string;
      proposed_slug: string;
      accepted_page_id: string | null;
      screenshot_object_key: string | null;
      diff_status: "pass" | "warn" | "fail" | null;
      diff_pct: number | null;
      cluster_key: string;
      cluster_label: string | null;
      notes: unknown;
    }>;

    // issue #250 (WS4) — fidelity rollup. A composed page with a source
    // screenshot but no diff_status is UNVERIFIED (the gate never graded it);
    // pages missing a source screenshot are unverified by definition. warn +
    // fail are the pages the closing report must name out loud.
    const fidelity = {
      pass: 0,
      warn: 0,
      fail: 0,
      unverified: 0,
      overThreshold: [] as { sourceUrl: string; diffStatus: "warn" | "fail"; diffPct: number }[],
    };
    for (const p of pages) {
      if (p.diff_status === "pass") fidelity.pass += 1;
      else if (p.diff_status === "warn" || p.diff_status === "fail") {
        fidelity[p.diff_status] += 1;
        fidelity.overThreshold.push({
          sourceUrl: p.source_url,
          diffStatus: p.diff_status,
          diffPct: p.diff_pct ?? 1,
        });
      } else if (p.accepted_page_id !== null || p.screenshot_object_key === null) {
        // Composed-but-ungraded, or never screenshotted: nothing measured it.
        fidelity.unverified += 1;
      }
    }

    // Clusters.
    const clusterMap = new Map<string, { label: string | null; count: number }>();
    for (const p of pages) {
      const entry = clusterMap.get(p.cluster_key) ?? { label: p.cluster_label, count: 0 };
      entry.count += 1;
      if (!entry.label && p.cluster_label) entry.label = p.cluster_label;
      clusterMap.set(p.cluster_key, entry);
    }

    // Redirects: same rule the compose tx applies (#196) — accepted
    // pages whose old path differs from the Caelo path, root excluded.
    let redirectsCreated = 0;
    for (const p of pages) {
      if (!p.accepted_page_id) continue;
      try {
        const path = new URL(p.source_url).pathname.replace(/\/$/, "") || "/";
        if (path !== "/" && path !== `/${p.proposed_slug}`) redirectsCreated += 1;
      } catch {
        // unparseable source_url — no redirect was created for it
      }
    }

    // Crawl errors from the #192 checkpoint slice.
    const state =
      typeof run.crawl_state === "string"
        ? (JSON.parse(run.crawl_state) as { errors?: unknown })
        : ((run.crawl_state ?? {}) as { errors?: unknown });
    const crawlErrors = (Array.isArray(state.errors) ? state.errors : [])
      .filter(
        (e): e is { url: string; reason: string } =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { url?: unknown }).url === "string" &&
          typeof (e as { reason?: unknown }).reason === "string",
      )
      .slice(0, 50);

    // Notes grouped by category, applied/suggested split, ≤5 samples.
    type Note = { category: z.infer<typeof noteCategory>; note: string; applied: boolean };
    const byCategory = new Map<
      string,
      {
        applied: number;
        suggested: number;
        samples: { sourceUrl: string; note: string; applied: boolean }[];
      }
    >();
    for (const p of pages) {
      const parsed = typeof p.notes === "string" ? (JSON.parse(p.notes) as unknown) : p.notes;
      if (!Array.isArray(parsed)) continue;
      for (const n of parsed as Note[]) {
        if (!n || typeof n.note !== "string") continue;
        const entry = byCategory.get(n.category) ?? { applied: 0, suggested: 0, samples: [] };
        if (n.applied) entry.applied += 1;
        else entry.suggested += 1;
        if (entry.samples.length < 5) {
          entry.samples.push({ sourceUrl: p.source_url, note: n.note, applied: n.applied });
        }
        byCategory.set(n.category, entry);
      }
    }

    return ok({
      sourceUrl: run.source_url,
      status: run.status,
      pagesSeen: run.pages_seen,
      pagesExtracted: run.pages_extracted,
      acceptedPages: pages.filter((p) => p.accepted_page_id !== null).length,
      clusters: [...clusterMap.entries()].map(([clusterKey, v]) => ({
        clusterKey,
        label: v.label,
        count: v.count,
      })),
      redirectsCreated,
      crawlErrors,
      pagesMissingScreenshot: pages.filter((p) => p.screenshot_object_key === null).length,
      fidelity,
      siteDesignTokens: parseJsonbColumn(run.site_design_tokens),
      notes: [...byCategory.entries()].map(([category, v]) => ({
        category: category as z.infer<typeof noteCategory>,
        ...v,
      })),
    });
  },
});

export const cleanupImportRunOp = defineOperation({
  name: "imports.cleanup_run",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE import_runs SET status = 'completed' WHERE id = ${input.runId}::uuid
    `);
    // Remove non-accepted import_pages rows (cascading screenshot cleanup
    // happens via pgBackRest backups; MinIO objects are GCed by P14
    // review pass).
    await tx.execute(sql`
      DELETE FROM import_pages
       WHERE run_id = ${input.runId}::uuid AND accepted_page_id IS NULL
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.cleanup_run",
      input,
      succeeded: true,
      resultSummary: `cleaned up ${input.runId}`,
    });
    return ok({});
  },
});

/**
 * P19 — `imports.compose_from_run` synthesises a Caelo-shaped site from
 * a `ready_for_review` import run in one transaction:
 *
 *   1. Aggregates `proposed_theme_tokens` across all pages (majority
 *      value per key) → writes/updates `structured_sets kind=theme
 *      slug=site` so the next render emits the imported site's CSS
 *      vars.
 *   2. Reuses the seeded `site-default` layout (or `defaults.default_layout_id`
 *      when set) as the chrome — a v1 simplification; the Owner can
 *      later add header/footer modules via `add_module_to_layout` from
 *      chat. Building a fresh layout from imported chrome is a P19
 *      polish concern.
 *   3. Creates a single template (slug from input, default
 *      `imported-page`) bound to that layout. HTML carries one
 *      `<caelo-slot name="content">` so the per-page modules render
 *      inside it.
 *   4. For each `import_pages` row not yet accepted: inserts a page row
 *      bound to the new template, materialises each `proposed_modules`
 *      entry into a real `modules` row + `page_modules` mapping, marks
 *      `accepted_page_id`.
 *
 * Idempotency: skips pages that already have `accepted_page_id`. If
 * the run has no unaccepted pages left, returns the prior synthesis.
 *
 * Per CLAUDE.md §11: open to ai because the user's "compose from this
 * crawl" intent is content-shaped — no hard-to-revert chrome change.
 * The Owner reviews the resulting drafts via the standard publish flow.
 */
export const composeFromImportRunOp = defineOperation({
  name: "imports.compose_from_run",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      /** Slug for the new template that the imported pages bind to. */
      templateSlug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .default("imported-page"),
      /** Subset of import_pages to materialise; omitted = all not-yet-accepted. */
      includeImportPageIds: z.array(z.string().uuid()).optional(),
    })
    .strict(),
  output: z.object({
    themeTokensApplied: z.number().int(),
    /** Run #8 — crawled vars the theme layer refused, loud + verbatim
     *  (`theme-token-skipped-nonfont-typography:<token>=<value>`). */
    tokenNotes: z.array(z.string()),
    /** issue #247 — where the applied theme values came from:
     *  'sampled' = computed-style ground truth (extractor as extras),
     *  'extractor' = inline-CSS fallback only, 'none' = no tokens. */
    designTokenSource: z.enum(["sampled", "extractor", "none"]),
    layoutId: z.string(),
    /** The homepage cluster's template (first template when no home). */
    templateId: z.string(),
    /** issue #195 — one template per confirmed page-type cluster. */
    templatesByCluster: z.record(z.string(), z.string()),
    pageIds: z.array(z.string()),
    homepageId: z.string().nullable(),
    skippedAlreadyAccepted: z.number().int(),
    /** issue #195 — formatted genesis-inventory over the homepage. */
    designInventory: z.string().nullable(),
    /** issue #196 — 301s written from old URLs to new Caelo paths. */
    redirectsCreated: z.number().int(),
    /** issue #253 — chrome blocks bound at the layout ("header"/"footer"). */
    chromeBound: z.array(z.string()),
    /** issue #253 — loud chrome notes (missing layout block, slot already bound). */
    chromeNotes: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    // 1. Run must exist + be reviewable.
    const runRows = (await tx.execute(sql`
      SELECT id::text AS id, source_url, status, site_design_tokens
      FROM import_runs WHERE id = ${input.runId}::uuid LIMIT 1
    `)) as unknown as {
      id: string;
      source_url: string;
      status: string;
      site_design_tokens: unknown;
    }[];
    const run = runRows[0];
    if (!run) {
      return err({
        kind: "HandlerError",
        operation: "imports.compose_from_run",
        message: "import run not found",
      });
    }
    if (run.status !== "ready_for_review" && run.status !== "completed") {
      return err({
        kind: "HandlerError",
        operation: "imports.compose_from_run",
        message: `run is ${run.status}; wait for ready_for_review before composing`,
      });
    }

    // 2. Load every (or filtered) import_pages row.
    const pageRows = (await tx.execute(sql`
      SELECT id::text AS id, source_url, proposed_slug, proposed_title,
             proposed_modules, proposed_theme_tokens, accepted_page_id,
             diff_status, acknowledged_at,
             COALESCE(cluster_key, structural_signature, 'content') AS cluster_key,
             cluster_label, page_css
      FROM import_pages
      WHERE run_id = ${input.runId}::uuid
      ORDER BY created_at ASC
    `)) as unknown as Array<{
      id: string;
      source_url: string;
      proposed_slug: string;
      proposed_title: string;
      proposed_modules: unknown;
      proposed_theme_tokens: unknown;
      accepted_page_id: string | null;
      diff_status: "pass" | "warn" | "fail" | null;
      acknowledged_at: string | Date | null;
      cluster_key: string;
      cluster_label: string | null;
      page_css: string | null;
    }>;

    const filterSet = input.includeImportPageIds ? new Set(input.includeImportPageIds) : null;
    const eligible = pageRows.filter(
      (r) => r.accepted_page_id === null && (filterSet === null || filterSet.has(r.id)),
    );
    const skippedAlreadyAccepted = pageRows.length - eligible.length;

    if (eligible.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "imports.compose_from_run",
        message: "no import_pages to compose (all already accepted or filter empty)",
      });
    }

    // 3. Pick layout — site_defaults.default_layout_id if configured,
    // else the seeded `site-default` slug.
    const layoutRows = (await tx.execute(sql`
      SELECT COALESCE(
        (SELECT default_layout_id FROM site_defaults WHERE id = 1),
        (SELECT id FROM layouts WHERE slug = 'site-default' AND deleted_at IS NULL LIMIT 1)
      )::text AS id
    `)) as unknown as { id: string | null }[];
    const layoutId = layoutRows[0]?.id;
    if (!layoutId) {
      return err({
        kind: "HandlerError",
        operation: "imports.compose_from_run",
        message:
          "no layout to bind the new template — seed site-default or set site_defaults.default_layout_id",
      });
    }

    // 4. Aggregate theme tokens — for each key, majority value wins.
    type TokensPer = Record<string, string>;
    const tokenCounts: Record<string, Record<string, number>> = {};
    for (const r of eligible) {
      const tokens =
        typeof r.proposed_theme_tokens === "string"
          ? (JSON.parse(r.proposed_theme_tokens) as TokensPer)
          : ((r.proposed_theme_tokens ?? {}) as TokensPer);
      for (const [k, v] of Object.entries(tokens)) {
        if (typeof v !== "string" || v.length === 0) continue;
        tokenCounts[k] ??= {};
        tokenCounts[k][v] = (tokenCounts[k][v] ?? 0) + 1;
      }
    }
    let aggregatedTokens: Array<{ token: string; value: string; scope?: string }> = [];
    for (const [k, valueMap] of Object.entries(tokenCounts)) {
      let bestValue = "";
      let bestCount = -1;
      for (const [v, c] of Object.entries(valueMap)) {
        if (c > bestCount) {
          bestCount = c;
          bestValue = v;
        }
      }
      if (bestValue) {
        // Infer scope from token prefix so the theme renderer can group
        // by category. Unknown prefixes drop the scope (still valid).
        const scope = k.startsWith("color-")
          ? "color"
          : k.startsWith("font-")
            ? "font"
            : k.startsWith("space-")
              ? "space"
              : k.startsWith("radius-")
                ? "radius"
                : k.startsWith("shadow-")
                  ? "shadow"
                  : undefined;
        aggregatedTokens.push({
          token: k,
          value: bestValue,
          ...(scope ? { scope } : {}),
        });
      }
    }

    // 4b. issue #247 (WS1) — prefer SAMPLED tokens over extractor
    // tokens. The extractor reads inline-CSS :root vars off raw HTML
    // (best-effort, survives fetch-only crawls); the sampled aggregate
    // comes from getComputedStyle in a real render — what the browser
    // actually painted. Merge = extractor map first, sampled tuples
    // overwrite same-named keys; extractor-only keys survive as extra
    // context. Stored-but-malformed tokens fail loudly (no-fallbacks
    // pre-1.0) instead of silently degrading to extractor-only.
    let designTokenSource: "sampled" | "extractor" | "none" =
      aggregatedTokens.length > 0 ? "extractor" : "none";
    const rawSiteTokens = parseJsonbColumn(run.site_design_tokens);
    if (rawSiteTokens !== null) {
      const parsedSiteTokens = siteDesignTokensSchema.safeParse(rawSiteTokens);
      if (!parsedSiteTokens.success) {
        return err({
          kind: "HandlerError",
          operation: "imports.compose_from_run",
          message: `import_runs.site_design_tokens is malformed (schema drift?): ${parsedSiteTokens.error.message}. Re-run the ground-truth capture or clear the column.`,
        });
      }
      const sampledFlat = flattenSiteDesignTokens(parsedSiteTokens.data);
      if (sampledFlat.length > 0) {
        const byToken = new Map(aggregatedTokens.map((t) => [t.token, t]));
        for (const t of sampledFlat) byToken.set(t.token, t);
        aggregatedTokens = [...byToken.values()];
        designTokenSource = "sampled";
      }
    }

    // 5. Merge aggregated tokens into the active themes row via the
    // `themes.update_tokens` op (v0.11.0, #45 AC #12). The op emits
    // a theme_snapshots row + audit + acquires the per-entity lock,
    // so importer-driven theme writes show up in site history and can
    // be reverted like any other theme edit. Pre-v0.11 wrote a flat
    // structured_sets row at `theme/site`; the new primitive carries
    // DTCG-shaped jsonb.
    // Run #8 — loud skip notes for crawled vars the theme layer must
    // refuse (numeric "font families" et al). Surfaced in the compose
    // output so the AI relays them instead of the deploy failing later.
    const tokenNotes: string[] = [];
    if (aggregatedTokens.length > 0) {
      const set: Record<string, unknown> = {};
      for (const t of aggregatedTokens) {
        const prepared = prepareLegacyAggregatedToken(t);
        if (prepared === null) continue;
        if ("skipNote" in prepared) {
          tokenNotes.push(prepared.skipNote);
          continue;
        }
        set[prepared.canonicalPath] = prepared.value;
      }
      if (Object.keys(set).length > 0) {
        const r = await updateThemeTokensOp.handler(ctx, { set }, tx);
        if (!r.ok) {
          // Run #9 R8 — writes have started; throw so the WHOLE compose
          // rolls back instead of committing a half-applied theme.
          throw new OperationAbortError({
            kind: "HandlerError",
            operation: "imports.compose_from_run",
            message: `theme merge failed: ${
              typeof r.error === "object" && r.error && "message" in r.error
                ? String((r.error as { message: unknown }).message)
                : "unknown"
            }`,
          });
        }
      }
    }

    // 6. issue #195 — ONE TEMPLATE PER CONFIRMED CLUSTER (#194), not
    // one template for the whole site. The homepage cluster ('home')
    // always gets its own template: it is the design contract.
    //
    // Every cluster template carries header/content/footer blocks and
    // the cluster sample's page_css — pre-#195 the template was a bare
    // content slot with css='' and a literal bug remapped EVERY
    // header/footer module into `content`
    // (`m.blockName === "content" ? "content" : "content"`).
    interface ParsedModule {
      blockName: "header" | "content" | "footer";
      position: number;
      html: string;
      displayName: string;
    }
    const parseModules = (raw: unknown): ParsedModule[] =>
      (typeof raw === "string" ? JSON.parse(raw) : (raw ?? [])) as ParsedModule[];

    const slugify = (v: string): string =>
      v
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "pages";

    const clusters = new Map<string, typeof eligible>();
    for (const r of eligible) {
      const list = clusters.get(r.cluster_key) ?? [];
      list.push(r);
      clusters.set(r.cluster_key, list);
    }

    // issue #253 (WS0) — chrome binds ONCE at the LAYOUT level, never
    // per page. Layouts are Caelo's site-wide chrome surface
    // (layout_modules); the pre-#253 compose duplicated the crawled
    // header/footer into every page's template blocks while the layout
    // slots stayed unbound — every page rendered the loud-raw `_` where
    // the site header belonged. Layout placements render from module
    // html / field defaults (no content_instance binding), so the
    // chrome module carries the crawled markup directly.
    const chromeModules = new Map<"header" | "footer", string>();
    const ensureChromeModule = async (
      block: "header" | "footer",
      src: ParsedModule,
    ): Promise<string | null> => {
      const existing = chromeModules.get(block);
      if (existing) return existing;
      const modInsert = (await tx.execute(sql`
        INSERT INTO modules (slug, display_name, type, html, css, js, kind, description)
        VALUES (
          ${`imported-${input.runId.slice(0, 8)}-${block}`},
          ${src.displayName || `Imported ${block}`},
          ${deriveModuleType(src.displayName || block)},
          ${src.html}, '', '',
          'chrome',
          ${`Imported site ${block} — bound to the site layout; every page shows it, edit once, updates everywhere.`}
        )
        ON CONFLICT (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
          WHERE deleted_at IS NULL
          DO UPDATE SET html = EXCLUDED.html
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const moduleId = modInsert[0]?.id;
      if (!moduleId) return null;
      chromeModules.set(block, moduleId);
      return moduleId;
    };

    // Which chrome blocks does the chosen layout actually declare?
    // A layout without a header/footer block (e.g. `bare`) gets a loud
    // note in the result — never a silent skip (CLAUDE.md §2).
    const layoutBlockRows = (await tx.execute(sql`
      SELECT name FROM layout_blocks WHERE layout_id = ${layoutId}::uuid
    `)) as unknown as { name: string }[];
    const layoutBlockNames = new Set(layoutBlockRows.map((b) => b.name));
    const chromeBound: string[] = [];
    const chromeNotes: string[] = [];
    const chromeHandled = new Set<"header" | "footer">();
    const bindChromeToLayout = async (
      block: "header" | "footer",
      src: ParsedModule,
    ): Promise<void> => {
      if (chromeHandled.has(block)) return;
      chromeHandled.add(block);
      if (!layoutBlockNames.has(block)) {
        chromeNotes.push(`layout-missing-${block}-block`);
        return;
      }
      const moduleId = await ensureChromeModule(block, src);
      if (!moduleId) {
        chromeNotes.push(`${block}-module-create-failed`);
        return;
      }
      const existingBind = (await tx.execute(sql`
        SELECT module_id::text AS module_id FROM layout_modules
        WHERE layout_id = ${layoutId}::uuid AND block_name = ${block}
        LIMIT 1
      `)) as unknown as { module_id: string }[];
      if (existingBind[0]) {
        if (existingBind[0].module_id === moduleId) {
          chromeBound.push(block); // idempotent re-run
        } else {
          // The operator (or genesis) already has site chrome here —
          // importing must not clobber it. Loud note, operator decides.
          chromeNotes.push(`${block}-slot-already-bound-to-other-module`);
        }
        return;
      }
      await tx.execute(sql`
        INSERT INTO layout_modules (layout_id, block_name, position, module_id)
        VALUES (${layoutId}::uuid, ${block}, 0, ${moduleId}::uuid)
      `);
      chromeBound.push(block);
    };

    const ensureClusterTemplate = async (
      clusterKey: string,
      label: string | null,
      sampleCss: string,
    ): Promise<string | null> => {
      const suffix = clusterKey === "home" ? "home" : slugify(label ?? clusterKey);
      const slug = `${input.templateSlug}-${suffix}`.slice(0, 120);
      const existingTplRows = (await tx.execute(sql`
        SELECT id::text AS id FROM templates
        WHERE slug = ${slug} AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { id: string }[];
      // issue #253 — imported templates are CONTENT-ONLY; chrome lives
      // at the layout level. A re-run over a pre-#253 template migrates
      // it in place: content-only html, legacy chrome blocks dropped,
      // stale per-page chrome placements removed (their blocks no
      // longer exist, so the rows would be invisible orphans).
      const contentOnlyHtml =
        '<div data-template="imported-page"><caelo-slot name="content">_</caelo-slot></div>';
      if (existingTplRows[0]) {
        const tplId = existingTplRows[0].id;
        await tx.execute(sql`
          UPDATE templates SET html = ${contentOnlyHtml} WHERE id = ${tplId}::uuid
        `);
        await tx.execute(sql`
          DELETE FROM template_blocks
          WHERE template_id = ${tplId}::uuid AND name IN ('header', 'footer')
        `);
        await tx.execute(sql`
          DELETE FROM page_modules pm USING pages p
          WHERE pm.page_id = p.id AND p.template_id = ${tplId}::uuid
            AND pm.block_name IN ('header', 'footer')
        `);
        return tplId;
      }
      const displayName =
        clusterKey === "home"
          ? `Imported homepage (${run.source_url.slice(0, 50)})`
          : `Imported: ${label ?? clusterKey} (${run.source_url.slice(0, 40)})`;
      const tplInsert = (await tx.execute(sql`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (
          ${slug},
          ${displayName},
          ${contentOnlyHtml},
          ${sampleCss},
          ${layoutId}::uuid
        )
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const newId = tplInsert[0]?.id;
      if (!newId) return null;
      await tx.execute(sql`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${newId}::uuid, 'content', 'Content', 0)
      `);
      return newId;
    };

    // 7. Per cluster → template; per page → page + modules. Home first
    // so the homepage lands before the fan-out (homepage-first is the
    // migration contract).
    const createdPageIds: string[] = [];
    const templateIdsByCluster = new Map<string, string>();
    let homepageId: string | null = null;
    let redirectsCreated = 0;
    const orderedClusterKeys = [...clusters.keys()].sort((a, b) =>
      a === "home" ? -1 : b === "home" ? 1 : a.localeCompare(b),
    );
    for (const clusterKey of orderedClusterKeys) {
      const members = clusters.get(clusterKey) ?? [];
      const sample = members[0];
      if (!sample) continue;
      const templateIdForCluster = await ensureClusterTemplate(
        clusterKey,
        sample.cluster_label,
        sample.page_css ?? "",
      );
      if (!templateIdForCluster) {
        // Run #9 R8 — abort (rollback), never commit a partial compose.
        throw new OperationAbortError({
          kind: "HandlerError",
          operation: "imports.compose_from_run",
          message: `template creation failed for cluster ${clusterKey}`,
        });
      }
      templateIdsByCluster.set(clusterKey, templateIdForCluster);

      for (const r of members) {
        // Block on unacknowledged screenshot fail — same gate as accept_page.
        if (r.diff_status === "fail" && !r.acknowledged_at) {
          continue;
        }
        const proposedModules = parseModules(r.proposed_modules);
        const pageInsert = (await tx.execute(sql`
          INSERT INTO pages (slug, locale, title, name, status, template_id, version)
          VALUES (
            ${r.proposed_slug}, 'en',
            ${r.proposed_title || r.proposed_slug},
            ${r.proposed_title || r.proposed_slug},
            'draft', ${templateIdForCluster}::uuid, 1
          )
          ON CONFLICT (slug, locale, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
            WHERE deleted_at IS NULL
            DO UPDATE SET title = EXCLUDED.title, name = EXCLUDED.name,
                          template_id = EXCLUDED.template_id
          RETURNING id::text AS id
        `)) as unknown as { id: string }[];
        const pageId = pageInsert[0]?.id;
        if (!pageId) continue;
        createdPageIds.push(pageId);
        if (clusterKey === "home" || r.proposed_slug === "home" || homepageId === null) {
          if (clusterKey === "home" || r.proposed_slug === "home" || homepageId === null) {
            homepageId = pageId;
          }
        }
        // Replace any existing page_modules for this page (idempotent re-run).
        await tx.execute(sql`DELETE FROM page_modules WHERE page_id = ${pageId}::uuid`);
        for (const m of proposedModules) {
          if (m.blockName === "header" || m.blockName === "footer") {
            // issue #253 — chrome binds at the LAYOUT, once per run,
            // never as a per-page placement (pre-#253 this inserted a
            // page_modules row per page, leaving layout slots unbound).
            await bindChromeToLayout(m.blockName, m);
            continue;
          }
          const modDisplayName = m.displayName || `${m.blockName} ${m.position}`;
          // Upsert: a re-compose over the same pages reuses their page
          // ids (pages upsert above), so the deterministic module slug
          // collides with run 1's orphaned module row — refresh it.
          const modInsert = (await tx.execute(sql`
            INSERT INTO modules (slug, display_name, type, html, css, js)
            VALUES (
              ${`imported-${pageId.slice(0, 8)}-${m.blockName}-${m.position}`},
              ${modDisplayName},
              ${deriveModuleType(modDisplayName)},
              ${m.html}, '', ''
            )
            ON CONFLICT (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
              WHERE deleted_at IS NULL
              DO UPDATE SET html = EXCLUDED.html, display_name = EXCLUDED.display_name
            RETURNING id::text AS id
          `)) as unknown as { id: string }[];
          const moduleId = modInsert[0]?.id;
          if (!moduleId) continue;
          // v0.12.0 — mint a fresh unsynced content_instance per placement
          // so page_modules.content_instance_id NOT NULL is satisfied.
          const ciInsert = (await tx.execute(sql`
            INSERT INTO content_instances (module_id, "values")
            VALUES (${moduleId}::uuid, '{}'::jsonb)
            RETURNING id::text AS id
          `)) as unknown as { id: string }[];
          const newCiId = ciInsert[0]?.id;
          if (!newCiId) continue;
          await tx.execute(sql`
            INSERT INTO page_modules
              (page_id, block_name, position, module_id, content_instance_id, sync_mode)
            VALUES (
              ${pageId}::uuid, 'content', ${m.position},
              ${moduleId}::uuid, ${newCiId}::uuid, 'unsynced'
            )
          `);
        }
        // Mark the staging row as accepted.
        await tx.execute(sql`
          UPDATE import_pages
             SET accepted_page_id = ${pageId}::uuid, accepted_at = now()
           WHERE id = ${r.id}::uuid
        `);

        // issue #196 — URL continuity. The old URL's path 301s to the
        // new Caelo path whenever they differ. Root ("/") never
        // redirects — the site root serves the migrated homepage.
        // Same tx as the page write: a migration cannot half-apply
        // its redirects (§11: cross-domain patches in one boundary).
        let sourcePath: string;
        try {
          const u = new URL(r.source_url);
          sourcePath = u.pathname.replace(/\/$/, "") || "/";
        } catch {
          sourcePath = "/";
        }
        const caeloPath = `/${r.proposed_slug}`;
        if (sourcePath !== "/" && sourcePath !== caeloPath) {
          // A LIVE page already owning the old path means the redirect
          // would shadow real content — that is an operator decision,
          // not a silent skip or overwrite (no-fallbacks pre-1.0).
          const shadow = (await tx.execute(sql`
            SELECT id::text AS id FROM pages
            WHERE slug = ${sourcePath.slice(1)} AND locale = 'en'
              AND deleted_at IS NULL AND id <> ${pageId}::uuid
            LIMIT 1
          `)) as unknown as { id: string }[];
          if (shadow[0]) {
            // Run #9 R8 — abort (rollback). Pre-fix this `return err`
            // COMMITTED every page inserted before the conflicting one
            // (23 mangled pages persisted although compose errored).
            throw new OperationAbortError({
              kind: "HandlerError",
              operation: "imports.compose_from_run",
              message: `redirect ${sourcePath} → ${caeloPath} would shadow the existing page '${sourcePath.slice(1)}' (${shadow[0].id}). Rename one of them (change_page_slug) or exclude this import page, then re-run compose. Nothing from this compose was applied.`,
            });
          }
          // Upsert keeps re-composes idempotent; pointing an existing
          // redirect at a NEW target is legitimate on re-run.
          await tx.execute(sql`
            INSERT INTO redirects (from_path, to_path, status_code, created_by)
            VALUES (${sourcePath}, ${caeloPath}, 301, ${ctx.actorId}::uuid)
            ON CONFLICT (from_path) DO UPDATE SET to_path = EXCLUDED.to_path
          `);
          redirectsCreated += 1;
        }
      }
    }

    // issue #195 — persist the design fact base for the AI's theme
    // decisions ("AI decides, code executes": facts are code-computed;
    // the model reads them from the run + the op result).
    const homeSample = clusters.get("home")?.[0];
    let designInventory: string | null = null;
    if (homeSample) {
      const homeHtml = parseModules(homeSample.proposed_modules)
        .map((m) => m.html)
        .join("\n");
      const inv = inventoryGenesisDraft(`${homeHtml}\n<style>${homeSample.page_css ?? ""}</style>`);
      designInventory = formatGenesisInventory(inv);
      await tx.execute(sql`
        UPDATE import_runs SET design_inventory = ${designInventory}
        WHERE id = ${input.runId}::uuid
      `);
    }

    const templateId = templateIdsByCluster.get("home") ?? [...templateIdsByCluster.values()][0];
    if (!templateId) {
      // Run #9 R8 — abort (rollback): theme/import_runs writes above
      // must not survive a compose that produced no template.
      throw new OperationAbortError({
        kind: "HandlerError",
        operation: "imports.compose_from_run",
        message: "no template was created — every page was blocked or filtered",
      });
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.compose_from_run",
      input,
      succeeded: true,
      entityId: input.runId,
      resultSummary: `theme=${aggregatedTokens.length} layout=${layoutId} template=${templateId} pages=${createdPageIds.length} redirects=${redirectsCreated} skipped=${skippedAlreadyAccepted}`,
    });

    return ok({
      themeTokensApplied: aggregatedTokens.length - tokenNotes.length,
      tokenNotes,
      designTokenSource,
      layoutId,
      templateId,
      templatesByCluster: Object.fromEntries(templateIdsByCluster),
      pageIds: createdPageIds,
      homepageId,
      skippedAlreadyAccepted,
      designInventory,
      redirectsCreated,
      chromeBound,
      chromeNotes,
    });
  },
});

/**
 * v0.11.0 (#45 AC #12) — convert an importer-aggregated
 * `{token, value, scope?}` tuple into a `themes.update_tokens`-ready
 * `(canonicalPath, value)` pair.
 *
 * The legacy importer stores every theme value as a string. The new
 * DTCG schema accepts:
 *
 *   - color / dimension (color, spacing, radius, breakpoint) — flat
 *     string value, passed through as-is.
 *   - typography composite — `$value` must be an object with
 *     fontFamily / fontSize / etc. so we wrap the legacy string as
 *     `{fontFamily: <value>}`.
 *   - shadow composite — `$value` must be a structured object;
 *     parsing the legacy stringified shadow ("0 1px 2px rgba(...)") is
 *     out of scope for v0.11.0, so shadow tokens from the importer are
 *     dropped (returns null). Importers that need full shadow support
 *     should hand-edit the theme after the run.
 *
 * Scope → category mirrors migration 0097's back-fill so imports land
 * at the same DTCG paths as an upgrade-in-place.
 */
/** Looks like a single CSS length the `spacing`/`radius` categories
 *  accept — including bare `0` (explicitly valid per the shared
 *  dimensionValueString schema; review finding). */
function isDimensionValue(v: string): boolean {
  const t = v.trim();
  return t === "0" || /^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|ch|pt)$/.test(t);
}

/**
 * True when a crawled value could plausibly be a font-family stack.
 * Rejects values whose PRIMARY entry (first comma segment, unquoted) is
 * numeric-only with an optional CSS unit — `13px`, `1.5`, `700`, `42px`.
 * Those are font SIZES / WEIGHTS / line-heights, and a "family" like
 * `13px` later fails the deploy hard with `theme-font-unresolvable:13px`
 * (run #8 live-hit: WordPress `--wp--preset--font-size--*` vars).
 */
export function isPlausibleFontFamilyValue(value: string): boolean {
  const primary = (value.split(",")[0] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (primary === "") return false;
  return !/^-?\d+(\.\d+)?[a-z%]*$/i.test(primary);
}

export function prepareLegacyAggregatedToken(t: {
  token: string;
  value: string;
  scope?: string;
}): { canonicalPath: string; value: unknown } | { skipNote: string } | null {
  // Determine category + basename. Order: explicit scope → name
  // keywords → value shape. The old tail defaulted every leftover to
  // `spacing`, which fed crawled junk vars into the wrong category —
  // live-hit 2026-07-12: WordPress's `--wp--preset--shadow--natural`
  // (a CSS shadow string) landed in `spacing.*` and the
  // TokenCategoryMismatch aborted the ENTIRE compose_from_run. No
  // guessing (CLAUDE.md 2): what we cannot place, we drop below.
  const name = t.token.toLowerCase();
  let category: string;
  if (t.scope === "color") category = "color";
  else if (t.scope === "font") category = "typography";
  else if (t.scope === "space") category = "spacing";
  else if (t.scope === "radius") category = "radius";
  else if (t.scope === "shadow") category = "shadow";
  else if (name.includes("shadow")) category = "shadow";
  else if (name.includes("radius")) category = "radius";
  else if (name.includes("font") || name.includes("family")) category = "typography";
  else if (/^#[0-9a-fA-F]{3,8}$/.test(t.value) || name.includes("color")) category = "color";
  else category = "spacing";

  // Drop shadow tokens — legacy stringified shadows don't round-trip
  // into the DTCG composite shape. v0.11.0 leaves the existing
  // shadow tokens untouched.
  if (category === "shadow") return null;

  // Run #8 live-hit: WordPress `--wp--preset--font-size--*` vars carry
  // "font" in the NAME but a bare dimension as the VALUE ("13px"). The
  // typography envelope below would register that as a font FAMILY, and
  // the generator's font resolver then fails the whole deploy with
  // `theme-font-unresolvable:13px`. Numeric-only values can never be a
  // family — skip LOUDLY (the caller relays the note) instead of
  // registering a token the deploy is guaranteed to choke on.
  if (category === "typography" && !isPlausibleFontFamilyValue(t.value)) {
    return { skipNote: `theme-token-skipped-nonfont-typography:${t.token}=${t.value}` };
  }

  // Strip the leading `<category>-` (or scope-prefixed) name so
  // `color-primary` becomes `primary`.
  let basename = t.token;
  const prefixes = [category, t.scope ?? "", "font", "space"].filter((p) => p);
  for (const p of prefixes) {
    if (basename.startsWith(`${p}-`)) {
      basename = basename.slice(p.length + 1);
      break;
    }
  }
  if (!basename) return null;

  const canonicalPath = `${category}.${basename}`;

  // Backstop: spacing/radius only accept single CSS lengths. A crawled
  // var that ends up here with anything else (a gradient, a shadow
  // list, a font stack) is site-specific noise — dropping ONE junk
  // token beats aborting the whole compose on a category mismatch.
  if ((category === "spacing" || category === "radius") && !isDimensionValue(t.value)) {
    return null;
  }

  // Shape the value: typography needs the composite object envelope;
  // everything else is a flat string.
  const value: unknown = category === "typography" ? { fontFamily: t.value } : t.value;

  return { canonicalPath, value };
}
