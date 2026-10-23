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
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";

/**
 * - `running`: every live server that reported it has it loaded.
 * - `failing`: at least one live server failed to load it — `problem` says why.
 * - `unreported`: active, but no live server has reported it yet (just
 *   activated, or every server is starting).
 * - `not_running`: not active, so no server runs it.
 */
export const pluginHealthState = z.enum(["running", "failing", "unreported", "not_running"]);

const pluginErrorSummary = z.object({
  phase: z.string(),
  /** transient (retried), plugin (the plugin's own code), core (Caelo; reported). */
  errorClass: z.enum(["transient", "plugin", "core"]),
  message: z.string(),
  occurrences: z.number().int(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  /** True once the problem went to the bug intake. */
  reported: z.boolean(),
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
  reported: boolean;
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
    reported: r.reported,
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
           e.first_seen_at, e.last_seen_at, e.bug_report_id IS NOT NULL AS reported
    FROM plugin_runtime r
    JOIN plugin_errors e ON e.id = r.error_id
    WHERE r.plugin_slug = ANY(${slugArray})
      AND r.state = 'error'
      AND r.heartbeat_at > now() - ${LIVE_WINDOW}::interval
    ORDER BY r.plugin_slug, e.last_seen_at DESC
  `)) as unknown as ErrorRow[];

  const recent = (await tx.execute(sql`
    SELECT plugin_slug, phase, error_class, message, occurrences,
           first_seen_at, last_seen_at, reported
    FROM (
      SELECT plugin_slug, phase, error_class, message, occurrences,
             first_seen_at, last_seen_at, bug_report_id IS NOT NULL AS reported,
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
