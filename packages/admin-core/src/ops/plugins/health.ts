// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin health for `plugins.list` / `plugins.get` (issue #1008).
 *
 * A plugin's status says what the Owner decided; its health says what the
 * running servers make of that decision. The plugin host writes both inputs
 * (plugin-host `runtime-health.ts`): `plugin_runtime` — per instance,
 * loaded or failed to load, heartbeated — and `plugin_errors` — every
 * problem, folded by fingerprint. Only rows with a recent heartbeat count,
 * so instances that stopped drop out by themselves.
 *
 * The AI reads this through `list_plugins` / `get_plugin` and can explain a
 * failing plugin to the operator without a round trip; the Owner sees it on
 * /settings/plugins.
 *
 * A plugin found on disk that fails verification on its FIRST discovery
 * (missing or invalid signature, no built bundle) never gets a `plugins`
 * row — a row would be an installation, and the old loader's fake rows
 * are what overwrote Owner decisions. Its problem lives only in
 * `plugin_errors`; {@link readDiscoveryFailures} surfaces those orphan
 * records so the plugin does not silently vanish.
 */

import { type TransactionRunner, textArray } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * - `running`: every live server that reported it has it loaded.
 * - `failing`: at least one live server failed to load it — `problem` says why.
 * - `awaiting_approval`: active, but its release asks for capabilities the
 *   Owner has not approved (#1267) or changes its manifest (#1332), so no
 *   server runs it until the release is approved at /settings/plugins —
 *   `awaitingCapabilities` names new capabilities, `awaitingRelease` says
 *   the manifest changed.
 * - `unreported`: active, but no live server has reported it yet (just
 *   activated, or every server is starting).
 * - `not_running`: not active, so no server runs it.
 */
export const pluginHealthState = z.enum([
  "running",
  "failing",
  "awaiting_approval",
  "unreported",
  "not_running",
]);

const pluginErrorReport = z.enum(["none", "local", "queued", "sent", "failed"]);

const pluginErrorSummary = z.object({
  phase: z.string(),
  /** transient (retried), plugin (the plugin's own code), core (Caelo; reported). */
  errorClass: z.enum(["transient", "plugin", "core"]),
  message: z.string(),
  occurrences: z.number().int(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  /**
   * What became of the bug report of a `core` problem: `none` (not filed),
   * `local` (recorded on this site only — bug forwarding is off), `queued`
   * (waiting to be sent to the Caelo team), `sent` (the Caelo team has it),
   * `failed` (sending failed; it stays recorded here). Only `sent` means
   * the team was told.
   */
  report: pluginErrorReport,
});

/**
 * #1390 — the plugin's change consumer is waiting out a failure backoff on
 * a live server: its failed batch is retried at `nextRetryAt`. The worst of
 * the live servers (most consecutive failures).
 */
const consumerBackoff = z.object({
  consecutiveFailures: z.number().int(),
  nextRetryAt: z.string(),
  lastError: z.string(),
});

/**
 * #1390 — one call the plugin made through its broker — a core operation
 * (`pages.list`) or its own storage (`plugin_storage.list`): calls, total
 * and longest ms.
 */
const callCost = z.object({
  op: z.string(),
  calls: z.number().int(),
  totalMs: z.number().int(),
  maxMs: z.number().int(),
});

/**
 * #1390 — what the plugin's work costs: the calls it made through its
 * broker on the live servers since `since` (the oldest live server's
 * start), costliest first. Wall time of each call — the database work plus
 * the wait for a pool connection — not database CPU. Reported, never acted
 * on (#1008).
 */
const callCostSummary = z.object({
  since: z.string().nullable(),
  calls: z.number().int(),
  totalMs: z.number().int(),
  /** The costliest operations by total time (at most 10). */
  ops: z.array(callCost),
});

export const pluginHealth = z.object({
  state: pluginHealthState,
  servers: z.object({ loaded: z.number().int(), failing: z.number().int() }),
  /** The capabilities the Owner must approve before it runs, when `awaiting_approval`. */
  awaitingCapabilities: z.array(z.string()),
  /** #1332 — when `awaiting_approval`: this release changes what the plugin
   *  declares (visitor operations, table kinds, tools …) and needs the
   *  Owner's approval even with no new capability. */
  awaitingRelease: z.boolean(),
  /** Why a live server failed to load it (the most recent), when `failing`. */
  problem: pluginErrorSummary.nullable(),
  /** The latest problems of the last 7 days, newest first (at most 5). */
  recentErrors: z.array(pluginErrorSummary),
  /** Its change consumer's failure backoff, when one is waiting (#1390). */
  consumerBackoff: consumerBackoff.nullable(),
  /** The core operations it called and their time (#1390). */
  callCost: callCostSummary,
});
export type PluginHealth = z.infer<typeof pluginHealth>;

/**
 * What an `awaiting_approval` plugin waits for, as one clause ("its release
 * asks for …"), for the AI tools that report it (#1267, #1332).
 */
export function awaitingApprovalReason(
  h: Pick<PluginHealth, "awaitingCapabilities" | "awaitingRelease">,
): string {
  const parts: string[] = [];
  if (h.awaitingCapabilities.length > 0) {
    parts.push(
      `asks for capabilities the Owner has not approved (${h.awaitingCapabilities.join(", ")})`,
    );
  }
  if (h.awaitingRelease) {
    parts.push(
      "changes what it declares (its visitor operations, table permissions, tools or other manifest entries) since the Owner last approved it",
    );
  }
  return `its release ${parts.join(" and ")}`;
}

/** A plugin found on disk that could not be verified, so it is not installed. */
export const pluginDiscoveryFailure = pluginErrorSummary.extend({ slug: z.string() });
type PluginDiscoveryFailure = z.infer<typeof pluginDiscoveryFailure>;

/** A server whose heartbeat is older than this is gone (heartbeat: 30 s). */
const LIVE_WINDOW = "2 minutes";
const RECENT_WINDOW = "7 days";
const RECENT_LIMIT = 5;
const COST_OPS_LIMIT = 10;

interface ErrorRow {
  plugin_slug: string;
  phase: string;
  error_class: "transient" | "plugin" | "core";
  message: string;
  occurrences: number;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  report: z.infer<typeof pluginErrorReport>;
}

/**
 * The `report` column for `plugin_errors` rows aliased `e`: read from the
 * linked bug report's forwarding state (migration 0329), so "reported"
 * never claims the Caelo team was told when the report stayed on this site.
 */
function reportState(errors: SQL): SQL {
  return sql`coalesce((
    SELECT CASE b.forwarding_state WHEN 'local_only' THEN 'local' ELSE b.forwarding_state END
    FROM ai_bug_reports b WHERE b.id = ${errors}.bug_report_id
  ), 'none')`;
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function summary(r: ErrorRow): z.infer<typeof pluginErrorSummary> {
  return {
    phase: r.phase,
    errorClass: r.error_class,
    message: r.message,
    occurrences: r.occurrences,
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    report: r.report,
  };
}

function costSummary(
  rows: ReadonlyArray<{
    op: string;
    calls: number;
    total_ms: number;
    max_ms: number;
    since: string | Date | null;
  }>,
): z.infer<typeof callCostSummary> {
  const ops = rows
    .map((r) => ({
      op: r.op,
      calls: Math.round(r.calls),
      totalMs: Math.round(r.total_ms),
      maxMs: Math.round(r.max_ms),
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls);
  const sinces = rows.flatMap((r) => (r.since === null ? [] : [iso(r.since)])).sort();
  return {
    since: sinces[0] ?? null,
    calls: ops.reduce((n, o) => n + o.calls, 0),
    totalMs: ops.reduce((n, o) => n + o.totalMs, 0),
    ops: ops.slice(0, COST_OPS_LIMIT),
  };
}

/**
 * Health of each plugin in `plugins`, keyed by slug.
 *
 * @param plugins the rows being returned: slug, status and the capabilities
 *   its release asks for that the Owner has not approved (#1306) — an active
 *   plugin with any does not load, which the servers alone cannot tell
 *   apart from "not reported yet".
 */
export async function readPluginHealth(
  tx: TransactionRunner,
  plugins: ReadonlyArray<{
    slug: string;
    status: string;
    unapprovedCapabilities: readonly string[];
    /** #1332 — the manifest is not the approved one. */
    releaseUnapproved: boolean;
  }>,
): Promise<Map<string, PluginHealth>> {
  const out = new Map<string, PluginHealth>();
  if (plugins.length === 0) return out;
  const slugs = plugins.map((p) => p.slug);
  const slugArray = textArray(slugs);

  const servers = (await tx.execute(sql`
    SELECT plugin_slug,
           count(*) FILTER (WHERE state = 'loaded')::int AS loaded,
           count(*) FILTER (WHERE state = 'error')::int AS failing
    FROM plugin_runtime
    WHERE plugin_slug = ANY(${slugArray})
      AND heartbeat_at > now() - ${LIVE_WINDOW}::interval
    GROUP BY plugin_slug
  `)) as unknown as { plugin_slug: string; loaded: number; failing: number }[];

  const problems = (await tx.execute(sql`
    SELECT DISTINCT ON (r.plugin_slug)
           r.plugin_slug, e.phase, e.error_class, e.message, e.occurrences,
           e.first_seen_at, e.last_seen_at, ${reportState(sql`e`)} AS report
    FROM plugin_runtime r
    JOIN plugin_errors e ON e.id = r.error_id
    WHERE r.plugin_slug = ANY(${slugArray})
      AND r.state = 'error'
      AND r.heartbeat_at > now() - ${LIVE_WINDOW}::interval
    ORDER BY r.plugin_slug, e.last_seen_at DESC
  `)) as unknown as ErrorRow[];

  const recent = (await tx.execute(sql`
    SELECT plugin_slug, phase, error_class, message, occurrences,
           first_seen_at, last_seen_at, report
    FROM (
      SELECT plugin_slug, phase, error_class, message, occurrences,
             first_seen_at, last_seen_at, ${reportState(sql`plugin_errors`)} AS report,
             row_number() OVER (PARTITION BY plugin_slug ORDER BY last_seen_at DESC) AS n
      FROM plugin_errors
      WHERE plugin_slug = ANY(${slugArray})
        AND last_seen_at > now() - ${RECENT_WINDOW}::interval
    ) ranked
    WHERE n <= ${RECENT_LIMIT}
    ORDER BY plugin_slug, last_seen_at DESC
  `)) as unknown as ErrorRow[];

  const backoffs = (await tx.execute(sql`
    SELECT DISTINCT ON (plugin_slug) plugin_slug, consumer_backoff
    FROM plugin_runtime
    WHERE plugin_slug = ANY(${slugArray})
      AND consumer_backoff IS NOT NULL
      AND heartbeat_at > now() - ${LIVE_WINDOW}::interval
    ORDER BY plugin_slug, (consumer_backoff->>'consecutiveFailures')::int DESC NULLS LAST
  `)) as unknown as { plugin_slug: string; consumer_backoff: unknown }[];

  // Summed over the live servers; each row is that server's total since it started.
  const costs = (await tx.execute(sql`
    SELECT r.plugin_slug, c.key AS op,
           sum((c.value->>'calls')::bigint)::float8 AS calls,
           sum((c.value->>'totalMs')::bigint)::float8 AS total_ms,
           max((c.value->>'maxMs')::bigint)::float8 AS max_ms,
           min(r.op_cost_since) AS since
    FROM plugin_runtime r, jsonb_each(r.op_cost) c
    WHERE r.plugin_slug = ANY(${slugArray})
      AND r.heartbeat_at > now() - ${LIVE_WINDOW}::interval
    GROUP BY r.plugin_slug, c.key
  `)) as unknown as {
    plugin_slug: string;
    op: string;
    calls: number;
    total_ms: number;
    max_ms: number;
    since: string | Date | null;
  }[];

  const serversBySlug = new Map(servers.map((s) => [s.plugin_slug, s]));
  const backoffBySlug = new Map(
    backoffs.flatMap((b) => {
      const parsed = consumerBackoff.safeParse(b.consumer_backoff);
      return parsed.success ? [[b.plugin_slug, parsed.data] as const] : [];
    }),
  );
  const problemBySlug = new Map(problems.map((p) => [p.plugin_slug, p]));
  for (const p of plugins) {
    const s = serversBySlug.get(p.slug) ?? { loaded: 0, failing: 0 };
    const problem = problemBySlug.get(p.slug);
    const state: PluginHealth["state"] =
      p.status !== "active"
        ? "not_running"
        : p.unapprovedCapabilities.length > 0 || p.releaseUnapproved
          ? "awaiting_approval"
          : s.failing > 0
            ? "failing"
            : s.loaded > 0
              ? "running"
              : "unreported";
    out.set(p.slug, {
      state,
      servers: { loaded: s.loaded, failing: s.failing },
      awaitingCapabilities: state === "awaiting_approval" ? [...p.unapprovedCapabilities] : [],
      awaitingRelease: state === "awaiting_approval" && p.releaseUnapproved,
      problem: state === "failing" && problem ? summary(problem) : null,
      recentErrors: recent.filter((r) => r.plugin_slug === p.slug).map(summary),
      consumerBackoff: backoffBySlug.get(p.slug) ?? null,
      callCost: costSummary(costs.filter((c) => c.plugin_slug === p.slug)),
    });
  }
  return out;
}

/**
 * The latest recent problem of every slug that has errors but no `plugins`
 * row: plugins found on disk that never verified, newest first. Once the
 * plugin verifies and gets its row, its old errors are its own history
 * (`recentErrors`) instead.
 *
 * @param slug only this slug (plugins.get), else every slug.
 */
export async function readDiscoveryFailures(
  tx: TransactionRunner,
  slug?: string,
): Promise<PluginDiscoveryFailure[]> {
  const rows = (await tx.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (e.plugin_slug)
             e.plugin_slug, e.phase, e.error_class, e.message, e.occurrences,
             e.first_seen_at, e.last_seen_at, ${reportState(sql`e`)} AS report
      FROM plugin_errors e
      WHERE NOT EXISTS (SELECT 1 FROM plugins p WHERE p.slug = e.plugin_slug)
        AND e.last_seen_at > now() - ${RECENT_WINDOW}::interval
        ${slug === undefined ? sql`` : sql`AND e.plugin_slug = ${slug}`}
      ORDER BY e.plugin_slug, e.last_seen_at DESC
    ) latest
    ORDER BY last_seen_at DESC
  `)) as unknown as ErrorRow[];
  return rows.map((r) => pluginDiscoveryFailure.parse({ slug: r.plugin_slug, ...summary(r) }));
}

/**
 * What `plugins.get` answers for a slug that is not installed but was
 * found and failed verification: says why and what fixes it.
 */
export function describeDiscoveryFailure(f: PluginDiscoveryFailure): string {
  return (
    `Plugin "${f.slug}" is not installed: Caelo found it on disk but could not verify it ` +
    `(${f.phase}, ${f.errorClass}, ${f.occurrences}x, last ${f.lastSeenAt}): ${f.message}. ` +
    "Nothing of it is loaded. Fix: rebuild the plugin (dist/index.js) and sign its manifest again, then redeploy or restart; " +
    "it then appears in /settings/plugins awaiting activation."
  );
}
