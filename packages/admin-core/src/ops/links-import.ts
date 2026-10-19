// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — finalising an import run's internal links
 * (open point 1 of rollout C, PR #873; maintainer decision: option b).
 *
 * While a run is active, links its rebuild writes to the run's planned
 * but not-yet-built pages are kept literal and recorded in
 * `import_run_links` (see `links/import-targets.ts`). Finalising runs the
 * link migration scoped to the run — only those recorded literals, on
 * the run's chat branch (and on main when an Owner / the system
 * finalises, e.g. the run's cleanup) — converts every one whose page now
 * exists, and marks the rest unresolved for the run report. Never
 * guessed: a link still matching no page stays literal and is listed.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import {
  canonicaliseUrl,
  type ExecutionContext,
  err,
  linkCanonicaliseRun,
  ok,
  parseLinkRef,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { loadLinkTargetLookup } from "../links/canonicalise.js";
import { migrateLinksToReferences } from "../links/migrate.js";
import { recordLinkMigrationRun } from "./links.js";

/** The outcome of finalising one run's links. */
export interface ImportLinkFinalisation {
  readonly converted: number;
  readonly resolved: number;
  readonly unresolved: number;
  /** The link migration run recorded for it, or null when nothing was pending. */
  readonly migrationRunId: string | null;
}

/**
 * Finalise `runId`'s recorded links in `tx`.
 *
 * @param includeMain convert main-line rows too. Only for Owner / system
 *   callers: a chat's AI writes reach main through Stage, never directly.
 */
export async function finaliseImportLinks(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  runId: string,
  includeMain: boolean,
): Promise<ImportLinkFinalisation | null> {
  const runs = (await tx.execute(sql`
    SELECT r.source_url, cs.chat_branch_id::text AS branch_id
      FROM import_runs r
      LEFT JOIN chat_sessions cs ON cs.id = r.chat_session_id AND cs.discarded_at IS NULL
     WHERE r.id = ${runId}::uuid
  `)) as unknown as { source_url: string; branch_id: string | null }[];
  const run = runs[0];
  if (!run) return null;
  const recorded = (await tx.execute(sql`
    SELECT value FROM import_run_links WHERE run_id = ${runId}::uuid AND status <> 'resolved'
  `)) as unknown as { value: string }[];
  if (recorded.length === 0) {
    return { converted: 0, resolved: 0, unresolved: 0, migrationRunId: null };
  }
  let sourceHost: string[] = [];
  try {
    sourceHost = [new URL(run.source_url).host.toLowerCase()];
  } catch {
    // An unparsable source URL only means its absolute links stay literal.
  }
  const only = new Set(recorded.map((r) => r.value));
  const result = await migrateLinksToReferences(tx, {
    apply: true,
    actorId: ctx.actorId,
    description: `Import links resolved to page references (import run ${runId.slice(0, 8)})`,
    includeMain,
    branches: run.branch_id ? [run.branch_id] : [],
    extraOwnHosts: sourceHost,
    only,
  });
  const locations = new Map<string, string>();
  for (const u of result.unresolved) {
    locations.set(u.value, `${u.label}${u.branchId ? " (in the migration chat)" : ""}: ${u.where}`);
  }
  // A recorded link is resolved when it now names an existing page in
  // the run's view of the site — wherever the content holding it lives.
  const lookup = await loadLinkTargetLookup(tx, run.branch_id, sourceHost);
  let unresolvedCount = 0;
  for (const value of only) {
    const probe = linkCanonicaliseRun(lookup, { mode: "report" });
    const resolves = parseLinkRef(canonicaliseUrl(value, probe, "link")) !== null;
    if (!resolves) {
      unresolvedCount += 1;
      const location = locations.get(value) ?? "";
      await tx.execute(sql`
        UPDATE import_run_links
           SET status = 'unresolved', location = COALESCE(NULLIF(${location}, ''), location),
               updated_at = now()
         WHERE run_id = ${runId}::uuid AND value = ${value}
      `);
    } else {
      await tx.execute(sql`
        UPDATE import_run_links SET status = 'resolved', updated_at = now()
         WHERE run_id = ${runId}::uuid AND value = ${value}
      `);
    }
  }
  const migrationRunId = await recordLinkMigrationRun(tx, {
    mode: "import",
    trigger: "import",
    importRunId: runId,
    actorId: ctx.actorId,
    result,
  });
  return {
    converted: Object.values(result.counts).reduce((a, b) => a + b, 0),
    resolved: only.size - unresolvedCount,
    unresolved: unresolvedCount,
    migrationRunId,
  };
}

export const resolveImportLinksOp = defineOperation({
  name: "imports.resolve_links",
  // Routine: it converts the run's own recorded links on the run's chat
  // branch (snapshotted, undone with the chat); main-line rows only for
  // human / system callers.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({
    converted: z.number(),
    resolved: z.number(),
    unresolved: z.number(),
    migrationRunId: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const out = await finaliseImportLinks(tx, ctx, input.runId, ctx.actorKind !== "ai");
    if (!out) {
      return err({
        kind: "HandlerError",
        operation: "imports.resolve_links",
        message: `no import run ${input.runId}. Next step: list_import_runs shows the run ids.`,
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.resolve_links",
      input,
      succeeded: true,
      entityId: input.runId,
      resultSummary: `converted ${out.converted}, resolved ${out.resolved}, unresolved ${out.unresolved}`,
    });
    return ok(out);
  },
});
