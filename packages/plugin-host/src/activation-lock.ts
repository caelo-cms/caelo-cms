// SPDX-License-Identifier: MPL-2.0

/**
 * #1144 — one plugin's `onActivate` runs once at a time across processes.
 *
 * Every admin instance and every build subprocess that loads a plugin runs
 * its `onActivate` seed. Two at once each found an empty table and both
 * seeded, so the consent-manager's default categories existed twice and the
 * duplicate-id check of list sources (#1121) failed the static build.
 *
 * #1220 — the serialization is a committed lease row
 * (`plugin_activation_leases`, migration 0403), taken and released in short
 * transactions of their own. It used to be a transaction-scoped advisory
 * lock held while the seed ran, and the seed's storage writes opened
 * transactions of their own from inside that one: a second connection of
 * the same pool per activation, the deadlock class the pool guard refuses
 * (query-api pool-guard.ts). Handing the plugin the lock's transaction
 * instead is not an option: the plugin's storage runs under the plugin's
 * identity and row-level security, never on a host transaction
 * (CLAUDE.md §2, one sandbox boundary).
 *
 * The lease: an activation inserts its row (or takes over one whose
 * `expires_at` passed — its process died), renews it on a heartbeat while
 * the seed runs, and deletes it when the seed ends. A second activation
 * polls, with no connection held, until the row is gone or lapsed.
 *
 * Rolling update: the previous release still serializes by the advisory
 * lock and knows nothing of the lease. Before taking the lease this release
 * try-locks that advisory lock in the same short transaction (never a
 * wait): held means a seed of the previous release runs right now, and the
 * activation polls like for a held lease. A seed of the previous release
 * that starts after this release took the lease is not seen; the cutover
 * leaves the previous revision nothing but its in-flight requests, so that
 * window is the seconds between one of them arriving and its activation.
 */

import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { PluginHostInfra } from "./dispatch.js";

/** How long a lease lives without a heartbeat. */
const LEASE_TTL_MS = 60_000;
/** How often a running activation renews its lease. */
const HEARTBEAT_MS = 15_000;
/** How long an activation waits for another one of the same plugin. */
const WAIT_MS = 10 * 60_000;

/** Timings of the lease, overridable by the tests. */
export interface ActivationLeaseTimings {
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
  readonly waitMs?: number;
}

/** The advisory-lock key the previous release serialized activations by. */
export function legacyActivationLockKey(slug: string): string {
  return `caelo:plugin-activate:${slug}`;
}

/** The holder label of the lease's short transactions (pool guard). */
const HOLDER = "plugins.activation_lease";

type Infra = Pick<PluginHostInfra, "adapter">;

interface Lease {
  readonly infra: Infra;
  readonly ctx: ExecutionContext;
  readonly slug: string;
  /** One id per activation. */
  readonly holder: string;
  readonly ttlMs: number;
}

/** Take the lease when it is free or lapsed. Never waits. */
async function tryAcquire(lease: Lease): Promise<boolean> {
  const { infra, ctx, slug, holder, ttlMs } = lease;
  return infra.adapter.withAdminTransaction(
    ctx,
    async (tx) => {
      const legacy = (await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${legacyActivationLockKey(slug)}, 0)) AS free`,
      )) as unknown as { free: boolean }[];
      if (legacy[0]?.free !== true) return false;
      // One statement inserts a free lease or takes over a lapsed one; a
      // live lease of another activation matches neither and returns nothing.
      const taken = (await tx.execute(sql`
        INSERT INTO plugin_activation_leases (slug, holder, acquired_at, expires_at)
        VALUES (${slug}, ${holder}, clock_timestamp(),
                clock_timestamp() + ${ttlMs}::int * interval '1 millisecond')
        ON CONFLICT (slug) DO UPDATE
          SET holder = EXCLUDED.holder,
              acquired_at = EXCLUDED.acquired_at,
              expires_at = EXCLUDED.expires_at
          WHERE plugin_activation_leases.expires_at <= clock_timestamp()
        RETURNING 1 AS taken
      `)) as unknown as { taken: number }[];
      return taken.length > 0;
    },
    { holder: HOLDER },
  );
}

/** Push the lease forward. False when it is no longer this activation's. */
async function renew(lease: Lease): Promise<boolean> {
  const { infra, ctx, slug, holder, ttlMs } = lease;
  return infra.adapter.withAdminTransaction(
    ctx,
    async (tx) => {
      const rows = (await tx.execute(sql`
        UPDATE plugin_activation_leases
        SET expires_at = clock_timestamp() + ${ttlMs}::int * interval '1 millisecond'
        WHERE slug = ${slug} AND holder = ${holder} AND expires_at > clock_timestamp()
        RETURNING 1 AS renewed
      `)) as unknown as { renewed: number }[];
      return rows.length > 0;
    },
    { holder: HOLDER },
  );
}

/** Delete the lease if it is still this activation's. */
async function release(lease: Lease): Promise<void> {
  const { infra, ctx, slug, holder } = lease;
  await infra.adapter.withAdminTransaction(
    ctx,
    async (tx) => {
      await tx.execute(sql`
        DELETE FROM plugin_activation_leases WHERE slug = ${slug} AND holder = ${holder}
      `);
    },
    { holder: HOLDER },
  );
}

/**
 * Run `fn` while holding the activation lease of plugin `slug`. No database
 * connection is held while `fn` runs.
 *
 * @param systemActorId - the host's system actor; the lease transactions run as it.
 * @throws Error when another activation of `slug` held the lease for the
 *   whole wait (`fn` did not run), or when this activation lost its lease
 *   while `fn` ran (no heartbeat renewed it in time, so another activation
 *   may have seeded at the same time).
 */
export async function runActivationSerialized<T>(
  infra: Infra,
  systemActorId: string,
  slug: string,
  fn: () => Promise<T>,
  timings: ActivationLeaseTimings = {},
): Promise<T> {
  const ttlMs = timings.ttlMs ?? LEASE_TTL_MS;
  const heartbeatMs = timings.heartbeatMs ?? HEARTBEAT_MS;
  const waitMs = timings.waitMs ?? WAIT_MS;
  const lease: Lease = {
    infra,
    ctx: { actorId: systemActorId, actorKind: "system", requestId: `plugin-activate-${slug}` },
    slug,
    holder: crypto.randomUUID(),
    ttlMs,
  };

  const deadline = Date.now() + waitMs;
  let pause = 50;
  while (!(await tryAcquire(lease))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `plugin "${slug}": another activation of this plugin ran for over ${Math.round(waitMs / 1000)} s, so its onActivate did not run here. Reload the plugin once the other activation finished (Settings → Plugins).`,
      );
    }
    await Bun.sleep(pause);
    pause = Math.min(pause * 2, 1_000);
  }

  let lost = false;
  // Beats run one after another, never two at once.
  let beat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    beat = beat.then(async () => {
      if (lost) return;
      try {
        if (!(await renew(lease))) lost = true;
      } catch (e) {
        // The next beat retries; the lease lapses only after `ttlMs`
        // without a successful one, and then `lost` reports it.
        console.error(`[plugin-host] activation lease heartbeat of "${slug}" failed:`, e);
      }
    });
  }, heartbeatMs);
  const stopBeating = async (): Promise<void> => {
    clearInterval(timer);
    await beat;
  };
  try {
    const out = await fn();
    await stopBeating();
    // The beats prove nothing when they kept failing (no pooled
    // connection, say): only a lease that is still this activation's and
    // unexpired right now shows that no other activation took it over.
    if (!lost && !(await renew(lease))) lost = true;
    if (lost) {
      throw new Error(
        `plugin "${slug}": the activation lease lapsed while onActivate ran (not renewed within ${Math.round(ttlMs / 1000)} s), so another activation may have run its seed at the same time. Reload the plugin (Settings → Plugins) and check the data it seeds.`,
      );
    }
    return out;
  } finally {
    await stopBeating();
    try {
      await release(lease);
    } catch (e) {
      // Not fatal: the lease lapses on its own after `ttlMs`, and the next
      // activation takes it over then.
      console.error(`[plugin-host] releasing the activation lease of "${slug}" failed:`, e);
    }
  }
}
