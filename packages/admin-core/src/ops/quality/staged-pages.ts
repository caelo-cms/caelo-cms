// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1721 — `quality_audits.staged_pages`: the pages of a running
 * audit's staged build, by id or by path, for a plugin's Stage-audit
 * batch calls.
 *
 * A plugin's audit check makes one call plus one per fact batch (#1632).
 * Every batch call used to carry every page of the build, so on a site of
 * 50,000 pages each of its 250+ calls moved the whole page list from the
 * audit's job to the admin (in upload parts) and on to the plugin. A
 * plugin that answers `batchPages: "own"` gets only its batch's pages and
 * the audit run's id instead, and reads the few other pages its rules name
 * (the pages a batch links to, their language versions) here.
 *
 * The audit run is the handle: what the op answers is derived from the
 * run's existing state, the way `quality_audits.claim` derives the run's
 * check pages (every published page of main, the state the staged build
 * holds), scoped to the ids and paths asked for. Nothing is stored for
 * it and nothing expires: the handle lives exactly as long as the run is
 * running, and refuses once the run has ended.
 */

import { defineOperation, textArray, uuidArray } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** Most ids, and most paths, one call names (one read each). */
export const STAGED_PAGES_MAX_PER_CALL = 1000;

export const stagedPagesOp = defineOperation({
  name: "quality_audits.staged_pages",
  readScope: "request",
  // Why system-only: the read behind a plugin's Stage-audit batch calls
  // (#1721, plugin SDK `batchPages: "own"`); the job and the system read
  // the run's pages through quality_audits.claim, the AI reads pages with
  // list_pages.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The audit run whose staged build is asked about (`PluginAuditFindingsArgs.auditRunId`). */
      auditRunId: z.string().uuid(),
      pageIds: z.array(z.string().uuid()).min(1).max(STAGED_PAGES_MAX_PER_CALL).optional(),
      /** Site paths as the page facts carry them (`/de/preise`). */
      paths: z.array(z.string().min(1).max(2048)).min(1).max(STAGED_PAGES_MAX_PER_CALL).optional(),
    })
    .strict()
    .refine((i) => i.pageIds !== undefined || i.paths !== undefined, {
      message: "name pageIds, paths or both",
    }),
  output: z.object({
    /** The staged pages among those asked; a page not listed is not a page of the build. */
    pages: z.array(z.object({ pageId: z.string(), path: z.string() })),
  }),
  handler: async (_ctx, input, tx) => {
    const run = (await tx.execute(sql`
      SELECT status FROM quality_audit_runs WHERE id = ${input.auditRunId}::uuid
    `)) as unknown as { status: string }[];
    const status = run[0]?.status;
    if (status !== "running") {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.staged_pages",
        message:
          status === undefined
            ? `there is no audit run ${input.auditRunId}: pass the auditRunId of the batch call you are answering`
            : `audit run ${input.auditRunId} is ${status}, not running: its staged pages are only answered while the audit runs (the handle ended with it)`,
      });
    }
    // The same pages quality_audits.claim lists as the run's check pages
    // (deploy/draft-pages.ts: the staged build holds exactly the published
    // pages of main), here only those asked for: by the primary key and by
    // pages_current_path_branch_uidx.
    const byId = input.pageIds ? sql`p.id = ANY(${uuidArray(input.pageIds)})` : sql`false`;
    const byPath = input.paths ? sql`p.current_path = ANY(${textArray(input.paths)})` : sql`false`;
    const rows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, p.current_path
      FROM pages p
      WHERE (${byId} OR ${byPath})
        AND p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
      ORDER BY p.current_path
    `)) as unknown as { page_id: string; current_path: string }[];
    return ok({ pages: rows.map((r) => ({ pageId: r.page_id, path: r.current_path })) });
  },
});
