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

import {
  pluginNotRunningReason,
  pluginRunsHere,
  reconcilePluginHostNow,
} from "@caelo-cms/plugin-host";
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
 * Bring this server's plugin host in line with the plugin rows before a
 * build decides on them (forced, past the request throttle), so a change
 * another instance made a moment ago is seen. Call it OUTSIDE any
 * transaction, before the build's start step: the reconcile reads the rows
 * and may load a plugin through connections of its own, which the pool
 * guard refuses from inside a transaction (#1225 — it used to run inside
 * the start step, was refused there, and the failure was swallowed).
 *
 * @returns null, or the AI-actionable refusal when it failed.
 */
export async function reconcilePluginsForBuild(): Promise<string | null> {
  try {
    await reconcilePluginHostNow();
    return null;
  } catch (e) {
    return `${e instanceof Error ? e.message : String(e)}. Nothing was built or published, because the plugin check could not see what runs on this server. Try again; if it repeats, the server log names the cause.`;
  }
}

/**
 * The active plugins that do not run: on this server (the one that would
 * build) and, from their runtime rows, on any other live server.
 *
 * Derived from the plugin rows, not only from this instance's memory: the
 * caller reconciled the host first ({@link reconcilePluginsForBuild}), and
 * every active row must then be running here — so a change another
 * instance made a moment ago, or a host that never finished booting, cannot
 * let a build through.
 */
export async function activePluginProblems(tx: TransactionRunner): Promise<DeployPluginProblem[]> {
  const active = (await tx.execute(sql`
    SELECT slug FROM plugins WHERE status = 'active' ORDER BY slug
  `)) as unknown as { slug: string }[];
  const out = new Map<string, string>();
  for (const { slug } of active) {
    if (!pluginRunsHere(slug)) {
      out.set(
        slug,
        `not running on this server: ${pluginNotRunningReason(slug) ?? "the plugin host has not loaded it"}`,
      );
    }
  }
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
 * The Stage warning for a build that ran while active plugins did not:
 * the staging site lacks what they add, and this Stage can never be
 * published. Null when every active plugin ran. Shown with the Stage
 * result (toast, Open changes, the stage_changes tool), not only on the
 * editor preview, so a successful Stage never hides it.
 */
export function describeStagedPluginProblems(
  problems: ReadonlyArray<DeployPluginProblem>,
): string | null {
  if (problems.length === 0) return null;
  const list = problems.map((p) => `"${p.slug}" (${p.reason})`).join("; ");
  return (
    `This Stage was built without ${problems.length === 1 ? "an active plugin" : `${problems.length} active plugins`}: ${list}. ` +
    "The staging site lacks what they add, and Publish live will refuse this Stage. " +
    "Fix the cause, reload the plugin (reload_plugin, or Settings → Plugins → Reload on all servers), then Stage again."
  );
}

/**
 * Why a Stage run may not be promoted: it was built while active plugins
 * were not running (recorded on the run), or it records nothing — a run
 * from before plugin health was recorded (NULL) or with an unreadable
 * value — so whether it is complete is unknown. Null when it may.
 */
export function stagedWithoutPlugins(recorded: unknown): string | null {
  const parsed = z.array(deployPluginProblem).safeParse(recorded);
  if (!parsed.success) {
    return (
      "This Stage was built before Caelo recorded whether every active plugin ran, so it may lack a plugin's output. " +
      "Stage again, then publish the new Stage."
    );
  }
  if (parsed.data.length === 0) return null;
  return (
    `This Stage was built while ${parsed.data.map((p) => `"${p.slug}"`).join(", ")} ${parsed.data.length === 1 ? "was" : "were"} not running, so it lacks ${parsed.data.length === 1 ? "that plugin's" : "those plugins'"} output. ` +
    "Stage again once they run (get_plugin shows their health), then publish the new Stage."
  );
}
