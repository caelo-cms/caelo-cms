// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — what a build would ship without: active plugins that do not run.
 *
 * A plugin that failed to load stays active (the Owner's decision is never
 * undone by an error). Editing and previews keep working without it — the
 * preview says so loudly — but a site built without it lacks what it adds
 * (localized links, a consent banner, …). So:
 *
 *   - a Stage records the problems on its run and reports them (staging is
 *     where the operator looks, and it is noindex);
 *   - a production build, and Publish live of a Stage, is refused while any
 *     active plugin does not run — here or on any live server — and a Stage
 *     built while one was not running is never promoted, even after the
 *     plugin recovered: it was rendered without it.
 */

import { pluginsNotRunningHere } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** One active plugin a build would lack, and why. */
export const deployPluginProblem = z.object({
  slug: z.string(),
  reason: z.string(),
});
export type DeployPluginProblem = z.infer<typeof deployPluginProblem>;

/** Live window for another server's runtime row (heartbeat: 30 s). */
const LIVE_WINDOW = "2 minutes";

/**
 * The active plugins that do not run: on this server (the one that would
 * build) and, from their runtime rows, on any other live server.
 */
export async function activePluginProblems(tx: TransactionRunner): Promise<DeployPluginProblem[]> {
  const out = new Map<string, string>();
  for (const p of pluginsNotRunningHere())
    out.set(p.slug, `not running on this server: ${p.reason}`);
  const elsewhere = (await tx.execute(sql`
    SELECT DISTINCT ON (r.plugin_slug) r.plugin_slug, e.message
    FROM plugin_runtime r
    JOIN plugins p ON p.slug = r.plugin_slug AND p.status = 'active'
    JOIN plugin_errors e ON e.id = r.error_id
    WHERE r.state = 'error' AND r.heartbeat_at > now() - ${LIVE_WINDOW}::interval
    ORDER BY r.plugin_slug, e.last_seen_at DESC
  `)) as unknown as { plugin_slug: string; message: string }[];
  for (const row of elsewhere) {
    if (!out.has(row.plugin_slug)) {
      out.set(row.plugin_slug, `not loading on another server: ${row.message}`);
    }
  }
  return [...out.entries()]
    .map(([slug, reason]) => ({ slug, reason }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The refusal message for Publish live / a production build, AI-actionable. */
export function describePluginProblems(problems: ReadonlyArray<DeployPluginProblem>): string {
  const list = problems.map((p) => `"${p.slug}" (${p.reason})`).join("; ");
  return (
    `Publish live is blocked: ${problems.length === 1 ? "an active plugin is" : `${problems.length} active plugins are`} not running — ${list}. ` +
    "The site would go live without what it adds. Fix the cause, then reload it on every server (reload_plugin, or Settings → Plugins → Reload on all servers), Stage again, and publish that Stage. " +
    "Nothing was switched off; editing keeps working."
  );
}

/**
 * Why a Stage run may not be promoted: it was built while active plugins
 * were not running (recorded on the run), or null.
 */
export function stagedWithoutPlugins(recorded: unknown): string | null {
  const parsed = z.array(deployPluginProblem).safeParse(recorded);
  if (!parsed.success || parsed.data.length === 0) return null;
  return (
    `This Stage was built while ${parsed.data.map((p) => `"${p.slug}"`).join(", ")} ${parsed.data.length === 1 ? "was" : "were"} not running, so it lacks ${parsed.data.length === 1 ? "that plugin's" : "those plugins'"} output. ` +
    "Stage again once they run (get_plugin shows their health), then publish the new Stage."
  );
}
