// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the link migration as Query API ops.
 *
 *   links.migrate_to_references   convert existing literal internal links
 *                                 into references (dry run or apply). The
 *                                 admin runs it once at boot after an
 *                                 upgrade; the Owner can re-run it.
 *   links.get_migration_report    the report: counts per surface, every
 *                                 link left literal and where it is.
 *   links.revert_migration        restore exactly what a run changed.
 *
 * Why a Query API op and not a SQL migration: the conversion needs the
 * canonicaliser and the site lookup (TypeScript); SQL migrations here are
 * schema-only. The data-backfill pattern this follows is the boot-time,
 * memoised, idempotent op call in apps/admin `hooks.server.ts`
 * (`seedSiteBaseUrl`, `seedStagingHost`).
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  type LinkMigrationChange,
  type LinkMigrationResult,
  migrateLinksToReferences,
  type UnresolvedLink,
} from "../links/migrate.js";
import { revertLinkMigration } from "../links/migrate-revert.js";
import { jsonbParam } from "../sql-helpers.js";

const unresolvedLink = z.object({
  surface: z.string(),
  entityKind: z.enum(["module", "contentInstance", "structuredSet", "pluginRow"]),
  entityId: z.string(),
  branchId: z.string().nullable(),
  label: z.string(),
  where: z.string(),
  value: z.string(),
  kind: z.string(),
});

const runSummary = z.object({
  runId: z.string(),
  mode: z.enum(["dry_run", "apply", "import"]),
  trigger: z.enum(["boot", "manual", "import"]),
  importRunId: z.string().nullable(),
  createdAt: z.string(),
  /** Links converted to references, per surface. */
  counts: z.record(z.string(), z.number()),
  entitiesChanged: z.number(),
  unresolvedCount: z.number(),
  siteSnapshotId: z.string().nullable(),
  revertedAt: z.string().nullable(),
});
export type LinkMigrationRunSummary = z.infer<typeof runSummary>;

/** Persist one run; returns its id. */
export async function recordLinkMigrationRun(
  tx: TransactionRunner,
  input: {
    readonly mode: "dry_run" | "apply" | "import";
    readonly trigger: "boot" | "manual" | "import";
    readonly importRunId: string | null;
    readonly actorId: string;
    readonly result: LinkMigrationResult;
  },
): Promise<string> {
  const r = input.result;
  const rows = (await tx.execute(sql`
    INSERT INTO link_migration_runs
      (mode, trigger, import_run_id, actor_id, site_snapshot_id, counts, entities_changed, unresolved, changes)
    VALUES (
      ${input.mode}, ${input.trigger}, ${input.importRunId}, ${input.actorId}::uuid,
      ${r.siteSnapshotId},
      ${jsonbParam(r.counts)},
      ${r.entitiesChanged},
      ${jsonbParam(r.unresolved)},
      ${jsonbParam(input.mode === "dry_run" ? [] : r.changes)}
    )
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error("link_migration_runs insert returned no row");
  return id;
}

interface RunRow {
  id: string;
  mode: "dry_run" | "apply" | "import";
  trigger: "boot" | "manual" | "import";
  import_run_id: string | null;
  created_at: string | Date;
  counts: unknown;
  entities_changed: number;
  unresolved_count: number | string;
  site_snapshot_id: string | null;
  reverted_at: string | Date | null;
}

const RUN_COLUMNS = sql`
  id::text AS id, mode, trigger, import_run_id::text AS import_run_id, created_at, counts,
  entities_changed, jsonb_array_length(unresolved) AS unresolved_count,
  site_snapshot_id::text AS site_snapshot_id, reverted_at
`;

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toSummary(r: RunRow): LinkMigrationRunSummary {
  const counts = typeof r.counts === "string" ? JSON.parse(r.counts) : r.counts;
  return {
    runId: r.id,
    mode: r.mode,
    trigger: r.trigger,
    importRunId: r.import_run_id,
    createdAt: iso(r.created_at) ?? "",
    counts: (counts ?? {}) as Record<string, number>,
    entitiesChanged: r.entities_changed,
    unresolvedCount: Number(r.unresolved_count),
    siteSnapshotId: r.site_snapshot_id,
    revertedAt: iso(r.reverted_at),
  };
}

const migrateOutput = z.object({
  /** True when `onlyIfNeverApplied` found an earlier applied run. */
  skipped: z.boolean(),
  run: runSummary.nullable(),
  /** The first unresolved links (the full list: links.get_migration_report). */
  unresolved: z.array(unresolvedLink),
});

export const migrateLinksToReferencesOp = defineOperation({
  name: "links.migrate_to_references",
  // Why human-only: it rewrites stored content on MAIN across the whole
  // site (and appends to every chat's pending work) outside any chat
  // branch. The admin runs it once at boot after the upgrade (system);
  // the Owner can dry-run / re-run it. The AI reads the result through
  // links.get_migration_report and fixes the links it lists.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      dryRun: z.boolean().default(false),
      trigger: z.enum(["boot", "manual"]).default("manual"),
      /** Boot: do nothing when an applied run already exists (even a reverted one). */
      onlyIfNeverApplied: z.boolean().default(false),
    })
    .strict(),
  output: migrateOutput,
  handler: async (ctx, input, tx) => {
    // Two admin instances booting together must not both convert.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('links.migrate_to_references'))`);
    if (input.onlyIfNeverApplied) {
      const prior = (await tx.execute(sql`
        SELECT ${RUN_COLUMNS} FROM link_migration_runs
         WHERE mode = 'apply' ORDER BY created_at DESC LIMIT 1
      `)) as unknown as RunRow[];
      if (prior[0]) return ok({ skipped: true, run: toSummary(prior[0]), unresolved: [] });
    }
    const result = await migrateLinksToReferences(tx, {
      apply: !input.dryRun,
      actorId: ctx.actorId,
      description: "Internal links stored as page references (#724 link migration)",
      includeMain: true,
      branches: "all",
    });
    const mode = input.dryRun ? "dry_run" : "apply";
    const runId = await recordLinkMigrationRun(tx, {
      mode,
      trigger: input.trigger,
      importRunId: null,
      actorId: ctx.actorId,
      result,
    });
    const converted = Object.values(result.counts).reduce((a, b) => a + b, 0);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "links.migrate_to_references",
      input,
      succeeded: true,
      entityId: runId,
      resultSummary: `${mode}: ${converted} link(s) converted in ${result.entitiesChanged} part(s), ${result.unresolved.length} unresolved`,
    });
    const rows = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS} FROM link_migration_runs WHERE id = ${runId}::uuid
    `)) as unknown as RunRow[];
    const row = rows[0];
    if (!row) throw new Error("link migration run vanished");
    return ok({ skipped: false, run: toSummary(row), unresolved: result.unresolved.slice(0, 50) });
  },
});

export const getLinkMigrationReportOp = defineOperation({
  name: "links.get_migration_report",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Omit for the latest site-wide run (dry run or apply). */
      runId: z.string().uuid().optional(),
      /** Free-text filter over the unresolved links (value, label, where). */
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  output: z.object({
    /** The run reported on: `runId`, else the latest site-wide run (a dry run included). */
    run: runSummary.nullable(),
    /**
     * The run a revert would undo: the latest applied site-wide run that
     * changed something and is not reverted yet. Independent of `run`, so
     * a later dry run or a no-op re-run never hides (or replaces) it.
     */
    revertableRun: runSummary.nullable(),
    unresolved: z.array(unresolvedLink),
    /** Matching unresolved links in total (before limit / offset). */
    unresolvedTotal: z.number(),
    /** The latest runs, newest first, for choosing another one. */
    recentRuns: z.array(runSummary),
  }),
  handler: async (_ctx, input, tx) => {
    const recent = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS} FROM link_migration_runs ORDER BY created_at DESC LIMIT 10
    `)) as unknown as RunRow[];
    const revertable = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS} FROM link_migration_runs
       WHERE mode = 'apply' AND entities_changed > 0 AND reverted_at IS NULL
       ORDER BY created_at DESC LIMIT 1
    `)) as unknown as RunRow[];
    const revertableRun = revertable[0] ? toSummary(revertable[0]) : null;
    const rows = (await tx.execute(
      input.runId
        ? sql`SELECT ${RUN_COLUMNS}, unresolved FROM link_migration_runs WHERE id = ${input.runId}::uuid`
        : sql`SELECT ${RUN_COLUMNS}, unresolved FROM link_migration_runs
               WHERE mode <> 'import' ORDER BY created_at DESC LIMIT 1`,
    )) as unknown as (RunRow & { unresolved: unknown })[];
    const row = rows[0];
    if (!row) {
      if (input.runId) {
        return err({
          kind: "HandlerError",
          operation: "links.get_migration_report",
          message: `no link migration run ${input.runId}. Next step: omit runId for the latest run, or pick one from recentRuns.`,
        });
      }
      return ok({
        run: null,
        revertableRun,
        unresolved: [],
        unresolvedTotal: 0,
        recentRuns: recent.map(toSummary),
      });
    }
    const all = (
      typeof row.unresolved === "string" ? JSON.parse(row.unresolved) : row.unresolved
    ) as UnresolvedLink[];
    const q = input.search?.toLowerCase();
    const matching = q
      ? all.filter((u) => `${u.value} ${u.label} ${u.where}`.toLowerCase().includes(q))
      : all;
    return ok({
      run: toSummary(row),
      revertableRun,
      unresolved: matching.slice(input.offset, input.offset + input.limit),
      unresolvedTotal: matching.length,
      recentRuns: recent.map(toSummary),
    });
  },
});

export const revertLinkMigrationOp = defineOperation({
  name: "links.revert_migration",
  // Why human-only: undoes a site-wide content rewrite on main; the
  // Owner decides (Settings → Internal links), the AI can only describe it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      /** Restore everything still unchanged and leave edited parts as they are. */
      skipConflicts: z.boolean().default(false),
    })
    .strict(),
  output: z.object({
    /**
     * False when parts were edited since the migration and `skipConflicts`
     * was not set: nothing was written, `conflicts` names every such part.
     */
    reverted: z.boolean(),
    restored: z.number(),
    skippedConflicts: z.number(),
    conflicts: z.array(
      z.object({
        entityKind: z.string(),
        entityId: z.string(),
        branchId: z.string().nullable(),
        reason: z.string(),
      }),
    ),
    siteSnapshotId: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT mode, changes, reverted_at FROM link_migration_runs WHERE id = ${input.runId}::uuid FOR UPDATE
    `)) as unknown as { mode: string; changes: unknown; reverted_at: string | Date | null }[];
    const run = rows[0];
    const fail = (message: string) =>
      err({ kind: "HandlerError" as const, operation: "links.revert_migration", message });
    if (!run) return fail(`no link migration run ${input.runId}.`);
    if (run.mode === "dry_run")
      return fail("a dry run changed nothing; there is nothing to revert.");
    if (run.reverted_at !== null) return fail("this run was already reverted.");
    const changes = (
      typeof run.changes === "string" ? JSON.parse(run.changes) : run.changes
    ) as LinkMigrationChange[];
    const outcome = await revertLinkMigration(tx, changes, {
      actorId: ctx.actorId,
      description: `Reverted link migration ${input.runId.slice(0, 8)} (#724)`,
      skipConflicts: input.skipConflicts,
    });
    if (outcome.conflicts.length > 0 && !input.skipConflicts) {
      // Not an error: the revert is refused as a whole (nothing written)
      // and the caller decides — revert again with skipConflicts: true to
      // restore everything else and keep those edits.
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "links.revert_migration",
        input,
        succeeded: false,
        entityId: input.runId,
        resultSummary: `refused: ${outcome.conflicts.length} part(s) edited since the migration`,
      });
      return ok({
        reverted: false,
        restored: 0,
        skippedConflicts: 0,
        conflicts: outcome.conflicts,
        siteSnapshotId: null,
      });
    }
    await tx.execute(sql`
      UPDATE link_migration_runs SET reverted_at = now(), reverted_by = ${ctx.actorId}::uuid
       WHERE id = ${input.runId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "links.revert_migration",
      input,
      succeeded: true,
      entityId: input.runId,
      resultSummary: `restored ${outcome.restored}, kept ${outcome.conflicts.length} edited part(s)`,
    });
    return ok({
      reverted: true,
      restored: outcome.restored,
      skippedConflicts: outcome.conflicts.length,
      conflicts: outcome.conflicts,
      siteSnapshotId: outcome.siteSnapshotId,
    });
  },
});
