// SPDX-License-Identifier: MPL-2.0

/**
 * Keeping this instance's plugin host in step with the database (#1008).
 *
 * The plugin rows are the truth: the Owner's decision per plugin. A change
 * made through one admin instance used to reach only that instance (the
 * post-commit host sync in admin-core `host-sync.ts`); every other instance
 * kept running what it had loaded at boot. On 2026-10-22 that left an
 * instance running a plugin the database no longer had active, and the
 * editor preview broke there.
 *
 * {@link syncPluginHost} reads the plugin rows — with each plugin's active
 * installation digest and unrevoked grants — in ONE statement, fingerprints
 * them, and when the fingerprint differs from the one this instance last
 * reconciled at, {@link reconcile} brings the host in line with exactly
 * those rows. One statement is one snapshot: a fingerprint is never
 * remembered without the rows that produced it (a counter bumped by a write
 * that has not committed yet could be). Any writer counts — an op, a
 * migration, a manual repair — and no trigger or shared counter row
 * serialises plugin writes. The rules:
 *
 *   - active, not loaded here     → load it (recorded by `loadReported`;
 *                                    a failure stays "not running here")
 *   - active, loaded but disabled → resume it
 *   - active, loaded from another row (reinstalled), or an external
 *     plugin whose approved artifact or grants changed
 *                                 → unload, load the current one
 *   - disabled, loaded            → stop it (tools, workers, dispatch)
 *   - anything else, or no row    → unload it completely
 *
 * The read is a handful of rows, throttled, and runs before admin requests
 * (`apps/admin` hooks) and on a timer — Cloud Run throttles CPU between
 * requests, so the request path is what makes it reliable there. Paths
 * that must not act on a stale view (the Publish-live gate) force it. A
 * failing plugin is retried only when the rows change (an Owner's "Reload
 * on all servers" touches its row), never in a loop.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { isPluginDisabled, type LoadedPlugin, loadedPlugins } from "./dispatch.js";
import { applyPluginLifecycle, deregisterPlugin } from "./lifecycle.js";
import { describeLoadError } from "./load-error.js";
import { loadActivatedPlugin, pluginHostBootstrapped } from "./loader.js";
import { clearPluginRuntime, recordPluginRuntime } from "./runtime-health.js";

/** Minimum gap between two state reads (per instance). */
const CHECK_INTERVAL_MS = 2_000;
/** The background check, for instances that serve no requests for a while. */
const TIMER_INTERVAL_MS = 30_000;

/** The fingerprint this instance reconciled at; null before the first. */
let reconciledAt: string | null = null;
let lastCheck = 0;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Active plugins that do not run on THIS instance, with the reason —
 * what render paths surface as a loud warning and Publish live refuses on.
 */
const notRunningHere = new Map<string, string>();

/** An active plugin that this instance could not load, and why. */
export interface PluginNotRunning {
  readonly slug: string;
  readonly reason: string;
}

/**
 * Missing-content marker for an active plugin that does not run here —
 * `plugin-not-running:<slug>`, same loud-marker convention as
 * `theme-asset-unbound:<slot>`.
 */
export function pluginNotRunningMarker(slug: string): string {
  return `plugin-not-running:${slug}`;
}

/** The slug of a {@link pluginNotRunningMarker}, or null for any other marker. */
export function pluginNotRunningSlug(marker: string): string | null {
  const m = /^plugin-not-running:([a-z][a-z0-9-]*)$/.exec(marker);
  return m?.[1] ?? null;
}

/** The active plugins this instance does not run right now. */
export function pluginsNotRunningHere(): ReadonlyArray<PluginNotRunning> {
  return [...notRunningHere.entries()]
    .map(([slug, reason]) => ({ slug, reason }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Whether `slug` runs on this instance: loaded and not stopped. What the
 * Publish-live gate checks every active plugin against.
 */
export function pluginRunsHere(slug: string): boolean {
  return loadedPlugins.bySlug(slug) !== undefined && !isPluginDisabled(slug);
}

/** Why `slug` does not run here, when this instance tried and failed. */
export function pluginNotRunningReason(slug: string): string | undefined {
  return notRunningHere.get(slug);
}

interface PluginRow {
  id: string;
  slug: string;
  status: string;
  tier: number;
  version: string;
  manifest_signature: string | null;
  updated_at: string;
  /** The active installation's artifact (external plugins), else null. */
  artifact_digest: string | null;
  /** That artifact's unrevoked grant ids, sorted, comma-separated. */
  grant_ids: string;
}

/**
 * Bring this instance in line with the plugin rows if they changed since
 * the last reconcile. Cheap when nothing changed (one sequence read, at
 * most every {@link CHECK_INTERVAL_MS}); concurrent callers share one run.
 * A no-op until the host is bootstrapped. Never throws: a failure is logged
 * and the next call tries again.
 *
 * @param force skip the throttle (an Owner's reload on this instance).
 */
export function syncPluginHost(force = false): Promise<void> {
  const host = pluginHostBootstrapped();
  if (!host) return Promise.resolve();
  armTimer();
  // A forced call must see rows newer than any run already in flight.
  if (inflight && !force) return inflight;
  const now = Date.now();
  if (!force && now - lastCheck < CHECK_INTERVAL_MS) return Promise.resolve();
  lastCheck = now;
  const run = (async () => {
    await inflight?.catch(() => undefined);
    try {
      const rows = await readPluginRows(host);
      const fingerprint = fingerprintOf(rows);
      if (!force && fingerprint === reconciledAt) return;
      await reconcile(host, rows);
      reconciledAt = fingerprint;
    } catch (e) {
      console.error(
        `[plugin-host] reconcile failed (retried on the next check): ${describeLoadError(e)}`,
      );
    }
  })().finally(() => {
    if (inflight === run) inflight = null;
  });
  inflight = run;
  return run;
}

function armTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    void syncPluginHost();
  }, TIMER_INTERVAL_MS);
  timer.unref?.();
}

/** Stop the background check and forget the reconcile state (tests). */
export function resetPluginHostSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  reconciledAt = null;
  lastCheck = 0;
  notRunningHere.clear();
}

type Host = NonNullable<ReturnType<typeof pluginHostBootstrapped>>;

function systemCtx(host: Host, requestId: string) {
  return { actorId: host.systemActorId, actorKind: "system" as const, requestId };
}

function fingerprintOf(rows: ReadonlyArray<PluginRow>): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** Every plugin row with what decides how it runs — one statement, one snapshot. */
async function readPluginRows(host: Host): Promise<PluginRow[]> {
  return host.infra.adapter.withAdminTransaction(
    systemCtx(host, "plugin-host-reconcile"),
    async (tx) =>
      (await tx.execute(sql`
        SELECT p.id::text AS id, p.slug, p.status, p.tier, p.version, p.manifest_signature,
               p.updated_at::text AS updated_at, v.artifact_digest,
               coalesce((
                 SELECT string_agg(g.id::text, ',' ORDER BY g.id::text)
                 FROM plugin_capability_grants g
                 WHERE g.plugin_id = p.id AND g.artifact_digest = v.artifact_digest
                   AND g.revoked_at IS NULL
               ), '') AS grant_ids
        FROM plugins p
        LEFT JOIN plugin_installation_versions v ON v.plugin_id = p.id AND v.status = 'active'
        ORDER BY p.slug
      `)) as unknown as PluginRow[],
  );
}

/**
 * Whether a loaded external plugin no longer runs the approved artifact
 * with its grants — a newly approved artifact can keep the version string,
 * and re-enabling issues new grant ids. Exported for its unit test.
 */
export function externalIdentityChanged(
  lp: Pick<LoadedPlugin, "externalApproval">,
  row: Pick<PluginRow, "artifact_digest" | "grant_ids">,
): boolean {
  const approval = lp.externalApproval;
  if (!approval) return false;
  if (approval.artifactDigest !== row.artifact_digest) return true;
  const loaded = [...approval.grantIds].sort().join(",");
  return approval.grantIds.length > 0 && loaded !== row.grant_ids;
}

async function unload(host: Host, slug: string): Promise<void> {
  deregisterPlugin(slug);
  notRunningHere.delete(slug);
  await clearPluginRuntime({ ...host, slug });
}

/** One pass over every plugin row (see the module docblock for the rules). */
async function reconcile(host: Host, rows: ReadonlyArray<PluginRow>): Promise<void> {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  // A plugin that failed to load and was then uninstalled (or is no longer
  // active) is not "not running here" any more — it is gone.
  for (const slug of [...notRunningHere.keys()]) {
    if (bySlug.get(slug)?.status !== "active") notRunningHere.delete(slug);
  }

  for (const lp of loadedPlugins.all()) {
    const row = bySlug.get(lp.slug);
    if (!row || (row.status !== "active" && row.status !== "disabled")) {
      console.log(
        `[plugin-host] reconcile: ${lp.slug} is no longer installed/active here — unloading`,
      );
      await unload(host, lp.slug);
    }
  }

  for (const row of rows) {
    if (row.status === "disabled") {
      notRunningHere.delete(row.slug);
      if (loadedPlugins.bySlug(row.slug) && !isPluginDisabled(row.slug)) {
        console.log(`[plugin-host] reconcile: ${row.slug} was disabled — stopping it here`);
        applyPluginLifecycle(row.slug, "disable");
        await clearPluginRuntime({ ...host, slug: row.slug });
      }
      continue;
    }
    if (row.status !== "active") {
      notRunningHere.delete(row.slug);
      continue;
    }
    let lp = loadedPlugins.bySlug(row.slug);
    if (
      lp &&
      (lp.pluginId !== row.id ||
        (row.tier === 2 && (lp.version !== row.version || externalIdentityChanged(lp, row))))
    ) {
      console.log(`[plugin-host] reconcile: ${row.slug} changed underneath — reloading`);
      await unload(host, row.slug);
      lp = undefined;
    }
    if (!lp) {
      const r = await loadActivatedPlugin(row.slug);
      if (r.loaded) {
        notRunningHere.delete(row.slug);
        console.log(`[plugin-host] reconcile: ${row.slug} is running here now`);
      } else {
        notRunningHere.set(row.slug, r.reason ?? "it did not load (no reason given)");
      }
      continue;
    }
    notRunningHere.delete(row.slug);
    if (isPluginDisabled(row.slug)) {
      console.log(`[plugin-host] reconcile: ${row.slug} was re-enabled — resuming it here`);
      applyPluginLifecycle(row.slug, "enable");
      // The disable above cleared this instance's runtime row, and the
      // heartbeat only refreshes rows that exist: without this the plugin's
      // health would never count this server again until a restart.
      await recordPluginRuntime({ ...host, slug: row.slug, state: "loaded", errorId: null });
    }
  }
}
