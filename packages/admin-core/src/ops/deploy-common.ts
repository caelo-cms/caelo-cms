// SPDX-License-Identifier: MPL-2.0

/**
 * Pieces the deploy ops share (deploy.ts: list / promote / rollback;
 * deploy-trigger.ts: Stage and every other build). Internal to admin-core.
 */

import { resolve } from "node:path";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext, PhaseTimer } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { resolveOutputRoot } from "../deploy/output-root.js";

/**
 * The directory a target's builds are written to. v0.2.78 — on Cloud Run
 * (gcp / aws / azure) the row's out_dir resolves to a read-only path, so
 * builds go to `/tmp/caelo-builds/<env>` (ephemeral: the publisher uploads
 * them right away, and #1211 deletes each one after its upload);
 * self-hosted keeps the row's out_dir.
 */
export function effectiveOutDir(provider: string | undefined, env: string, outDir: string): string {
  const isCloud = provider === "gcp" || provider === "aws" || provider === "azure";
  return isCloud ? `/tmp/caelo-builds/${env}` : outDir;
}

export const targetRow = z.object({
  id: z.string(),
  name: z.string(),
  env: z.enum(["dev", "staging", "production"]),
  outDir: z.string(),
  baseUrl: z.string(),
  robotsDefault: z.enum(["index", "noindex"]),
  isDefault: z.boolean(),
  // v0.2.85 — per-target page emission style. 'directory' (default)
  // emits <slug>/index.html; 'no-extension' emits bare <slug> with
  // Content-Type: text/html for clean URLs without bucket-website
  // redirect gymnastics.
  pageUrlStyle: z.enum(["directory", "no-extension"]),
});

/** A `deploy_targets` row as the deploy ops select it. */
export interface TargetDbRow {
  id: string;
  name: string;
  env: "dev" | "staging" | "production";
  out_dir: string;
  base_url: string;
  robots_default: "index" | "noindex";
  is_default: boolean;
  page_url_style: "directory" | "no-extension";
}

/** The columns every deploy op selects for a {@link TargetDbRow}. */
export const TARGET_COLUMNS = sql`id::text AS id, name, env, out_dir, base_url, robots_default, is_default, page_url_style`;

export function rowToTarget(r: TargetDbRow): z.infer<typeof targetRow> {
  return {
    id: r.id,
    name: r.name,
    env: r.env,
    outDir: r.out_dir,
    baseUrl: r.base_url,
    robotsDefault: r.robots_default,
    isDefault: r.is_default,
    pageUrlStyle: r.page_url_style ?? "directory",
  };
}

/**
 * The database clock now, as a run's `started_at`. Read before the run's
 * PhaseTimer starts, so `finished_at - started_at` always covers the
 * timed steps — the row itself is inserted only after preparation, and
 * the column default would start the run there (#1003).
 */
export async function runStartedAt(tx: TransactionRunner): Promise<string> {
  const rows = (await tx.execute(sql`SELECT clock_timestamp()::text AS at`)) as unknown as {
    at: string;
  }[];
  const at = rows[0]?.at;
  if (!at) throw new Error("clock_timestamp() returned no row");
  return at;
}

/** One log line per finished run with its step timings (Cloud Logging / docker logs). */
export function logRunTimings(
  kind: "stage" | "build" | "publish-live",
  runId: string,
  timer: PhaseTimer,
  extra: {
    status: "succeeded" | "failed";
    pageCount?: number;
    fileCount?: number;
    /** #1271 — the generator subprocess's peak resident memory over the build. */
    generatorPeakRssMb?: number;
  },
): void {
  console.info(
    `[deploy] ${kind} ${extra.status} in ${timer.totalMs()} ms`,
    JSON.stringify({ runId, ...extra, totalMs: timer.totalMs(), phases: timer.phases() }),
  );
}

/**
 * #1154 — the one path to live: a production build or publish runs only for
 * a human (an Owner-initiated production build, a Publish live, or an
 * approved proposal applied as its approver). There is no automatic
 * redeploy; a `system` caller asking for production is a code path that
 * must not exist, so it is refused before anything is built.
 *
 * @returns the refusal for a non-human production request, or null.
 */
export function productionNeedsHuman(
  ctx: ExecutionContext,
  targetEnv: string,
  operation: "deploy.trigger" | "deploy.promote",
): { kind: "HandlerError"; operation: string; message: string } | null {
  if (targetEnv !== "production" || ctx.actorKind === "human") return null;
  return {
    kind: "HandlerError",
    operation,
    message:
      "production is built only by a human Publish live (or an Owner-initiated production build) — nothing publishes automatically. Stage the change and let the Owner click Publish live.",
  };
}

/**
 * Absolute path of a run's build archive (`<outDir>/builds/<runId>`) as
 * deploy.trigger wrote it on THIS process — the #553 audit serves it when
 * the provider has no reachable staging origin.
 */
export function localBuildArchiveDir(args: {
  provider: string | undefined;
  env: string;
  outDir: string;
  runId: string;
}): string {
  return resolve(
    resolveOutputRoot(),
    effectiveOutDir(args.provider, args.env, args.outDir),
    "builds",
    args.runId,
  );
}
