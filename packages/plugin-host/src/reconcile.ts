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
 * Every write to the plugin rows bumps `plugin_host_generation` (migration
 * 0345, row triggers — whoever writes). {@link syncPluginHost} compares
 * that counter with the one this instance last reconciled at; when it
 * moved, {@link reconcile} brings the host in line:
 *
 *   - active, not loaded here     → load it (recorded by `loadReported`;
 *                                    a failure stays "not running here")
 *   - active, loaded but disabled → resume it
 *   - active, loaded from another row (reinstalled) or another external
 *     version                     → unload, load the current one
 *   - disabled, loaded            → stop it (tools, workers, dispatch)
 *   - anything else, or no row    → unload it completely
 *
 * The check is a single sequence read, throttled, and runs before admin
 * requests (`apps/admin` hooks) and on a timer — Cloud Run throttles CPU
 * between requests, so the request path is what makes it reliable there.
 * A failing plugin is retried only when the counter moves (an Owner's
 * "Reload on all servers" bumps it), never in a loop.
 */

import { sql } from "drizzle-orm";
import { isPluginDisabled, loadedPlugins } from "./dispatch.js";
import { applyPluginLifecycle, deregisterPlugin } from "./lifecycle.js";
import { describeLoadError } from "./load-error.js";
import { loadActivatedPlugin, pluginHostBootstrapped } from "./loader.js";
import { clearPluginRuntime } from "./runtime-health.js";

/** Minimum gap between two generation reads (per instance). */
const CHECK_INTERVAL_MS = 2_000;
/** The background check, for instances that serve no requests for a while. */
const TIMER_INTERVAL_MS = 30_000;

/** The generation this instance reconciled at; null before the first. */
let reconciledAt: bigint | null = null;
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

interface PluginRow {
  id: string;
  slug: string;
  status: string;
  tier: number;
  version: string;
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
  if (inflight) return inflight;
  const now = Date.now();
  if (!force && now - lastCheck < CHECK_INTERVAL_MS) return Promise.resolve();
  lastCheck = now;
  inflight = (async () => {
    try {
      const generation = await readGeneration(host);
      if (!force && generation === reconciledAt) return;
      await reconcile(host);
      reconciledAt = generation;
    } catch (e) {
      console.error(
        `[plugin-host] reconcile failed (retried on the next check): ${describeLoadError(e)}`,
      );
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
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

async function readGeneration(host: Host): Promise<bigint> {
  const rows = await host.infra.adapter.withAdminTransaction(
    systemCtx(host, "plugin-host-generation"),
    async (tx) =>
      (await tx.execute(sql`
        SELECT last_value::text AS value, is_called FROM plugin_host_generation
      `)) as unknown as { value: string; is_called: boolean }[],
  );
  const row = rows[0];
  if (!row) throw new Error("plugin_host_generation returned no row (migration 0345 missing?)");
  return row.is_called ? BigInt(row.value) : 0n;
}

async function readPluginRows(host: Host): Promise<PluginRow[]> {
  return host.infra.adapter.withAdminTransaction(
    systemCtx(host, "plugin-host-reconcile"),
    async (tx) =>
      (await tx.execute(sql`
        SELECT id::text AS id, slug, status, tier, version FROM plugins ORDER BY slug
      `)) as unknown as PluginRow[],
  );
}

async function unload(host: Host, slug: string): Promise<void> {
  deregisterPlugin(slug);
  notRunningHere.delete(slug);
  await clearPluginRuntime({ ...host, slug });
}

/** One pass over every plugin row (see the module docblock for the rules). */
async function reconcile(host: Host): Promise<void> {
  const rows = await readPluginRows(host);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

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
    if (lp && (lp.pluginId !== row.id || (row.tier === 2 && lp.version !== row.version))) {
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
    }
  }
}
