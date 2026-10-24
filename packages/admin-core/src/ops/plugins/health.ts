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

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * - `running`: every live server that reported it has it loaded.
 * - `failing`: at least one live server failed to load it — `problem` says why.
 * - `unreported`: active, but no live server has reported it yet (just
 *   activated, or every server is starting).
 * - `not_running`: not active, so no server runs it.
 */
export const pluginHealthState = z.enum(["running", "failing", "unreported", "not_running"]);

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

export const pluginHealth = z.object({
  state: pluginHealthState,
  servers: z.object({ loaded: z.number().int(), failing: z.number().int() }),
  /** Why a live server failed to load it (the most recent), when `failing`. */
  problem: pluginErrorSummary.nullable(),
  /** The latest problems of the last 7 days, newest first (at most 5). */
  recentErrors: z.array(pluginErrorSummary),
});
export type PluginHealth = z.infer<typeof pluginHealth>;

/** A plugin found on disk that could not be verified, so it is not installed. */
export const pluginDiscoveryFailure = pluginErrorSummary.extend({ slug: z.string() });
type PluginDiscoveryFailure = z.infer<typeof pluginDiscoveryFailure>;

/** A server whose heartbeat is older than this is gone (heartbeat: 30 s). */
const LIVE_WINDOW = "2 minutes";
const RECENT_WINDOW = "7 days";
const RECENT_LIMIT = 5;

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

/**
 * Health of each plugin in `plugins`, keyed by slug.
 *
 * @param plugins the rows being returned: slug + status.
 */
export async function readPluginHealth(
  tx: TransactionRunner,
  plugins: ReadonlyArray<{ slug: string; status: string }>,
): Promise<Map<string, PluginHealth>> {
  const out = new Map<string, PluginHealth>();
  if (plugins.length === 0) return out;
  const slugs = plugins.map((p) => p.slug);
  const slugArray = sql`ARRAY[${sql.join(
    slugs.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;

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

  const serversBySlug = new Map(servers.map((s) => [s.plugin_slug, s]));
  const problemBySlug = new Map(problems.map((p) => [p.plugin_slug, p]));
  for (const p of plugins) {
    const s = serversBySlug.get(p.slug) ?? { loaded: 0, failing: 0 };
    const problem = problemBySlug.get(p.slug);
    const state: PluginHealth["state"] =
      p.status !== "active"
        ? "not_running"
        : s.failing > 0
          ? "failing"
          : s.loaded > 0
            ? "running"
            : "unreported";
    out.set(p.slug, {
      state,
      servers: { loaded: s.loaded, failing: s.failing },
      problem: state === "failing" && problem ? summary(problem) : null,
      recentErrors: recent.filter((r) => r.plugin_slug === p.slug).map(summary),
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
