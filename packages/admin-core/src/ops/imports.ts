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

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

const runStatus = z.enum(["proposed", "crawling", "ready_for_review", "completed", "failed"]);

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
  screenshotObjectKey: z.string().nullable(),
  diffStatus: z.enum(["pass", "warn", "fail"]).nullable(),
  diffPct: z.number().nullable(),
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
  created_at: string | Date;
}

function toRunApi(r: RunDb): z.infer<typeof runRow> {
  const iso = (v: string | Date | null): string | null =>
    v ? (v instanceof Date ? v.toISOString() : String(v)) : null;
  return {
    id: r.id,
    sourceUrl: r.source_url,
    depth: r.depth,
    maxPages: r.max_pages,
    status: r.status,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    pagesSeen: r.pages_seen,
    pagesExtracted: r.pages_extracted,
    errorMessage: r.error_message,
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
  };
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
             approved_at, started_at, finished_at, pages_seen, pages_extracted,
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
             approved_at, started_at, finished_at, pages_seen, pages_extracted,
             error_message, created_at
      FROM import_runs WHERE id = ${input.runId}::uuid LIMIT 1
    `)) as unknown as RunDb[];
    const run = runs[0] ? toRunApi(runs[0]) : null;
    const pageRows = (await tx.execute(sql`
      SELECT id::text AS id, run_id::text AS run_id, source_url,
             proposed_slug, proposed_title, proposed_modules, proposed_theme_tokens,
             screenshot_object_key, diff_status, diff_pct,
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
      screenshot_object_key: string | null;
      diff_status: "pass" | "warn" | "fail" | null;
      diff_pct: number | null;
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
        screenshotObjectKey: p.screenshot_object_key,
        diffStatus: p.diff_status,
        diffPct: p.diff_pct,
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
      maxPages: z.number().int().min(1).max(500).default(50),
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
      maxPages: z.number().int().min(1).max(500).default(50),
    })
    .strict(),
  output: z.object({ runId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO import_runs (source_url, depth, max_pages, status, proposed_by)
      VALUES (${input.sourceUrl}, ${input.depth}, ${input.maxPages}, 'proposed', ${ctx.actorId}::uuid)
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
             approved_at, started_at, finished_at, pages_seen, pages_extracted,
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
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE import_pages
         SET diff_status = ${input.diffStatus},
             diff_pct = ${input.diffPct},
             screenshot_object_key = COALESCE(${input.screenshotObjectKey ?? null}, screenshot_object_key)
       WHERE id = ${input.importPageId}::uuid
    `);
    return ok({});
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
          }),
        )
        .max(500),
    })
    .strict(),
  output: z.object({ inserted: z.number() }),
  handler: async (_ctx, input, tx) => {
    let inserted = 0;
    for (const p of input.pages) {
      const r = (await tx.execute(sql`
        INSERT INTO import_pages (
          run_id, source_url, proposed_slug, proposed_title,
          proposed_modules, proposed_theme_tokens
        ) VALUES (
          ${input.runId}::uuid, ${p.sourceUrl}, ${p.proposedSlug}, ${p.proposedTitle},
          ${JSON.stringify(p.proposedModules)}::jsonb,
          ${JSON.stringify(p.proposedThemeTokens)}::jsonb
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
    for (const m of proposedModules) {
      const modRows = (await tx.execute(sql`
        INSERT INTO modules (slug, display_name, html, css, js)
        VALUES (
          ${`imported-${pageId.slice(0, 8)}-${m.blockName}-${m.position}`},
          ${m.displayName}, ${m.html}, '', ''
        )
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const moduleId = modRows[0]?.id;
      if (!moduleId) continue;
      await tx.execute(sql`
        INSERT INTO page_modules (page_id, block_name, position, module_id)
        VALUES (${pageId}::uuid, ${m.blockName}, ${m.position}, ${moduleId}::uuid)
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
