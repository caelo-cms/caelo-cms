// SPDX-License-Identifier: MPL-2.0

/**
 * The rotating key of the gateway's client-address hashes (#1338, #763 L3).
 *
 * Rate-limit buckets are keyed by a hash of the client address
 * (client-ip.ts `hashClientAddress`). Unkeyed, a stored IPv4 hash is
 * reversed by hashing all 2^32 addresses; as an HMAC it names nobody
 * without the key. The key lives in cms_public `gateway_ip_hash_keys`
 * (migration 0500), one per UTC day, so every gateway instance hashes an
 * address alike and their buckets agree:
 *
 *   - the first instance that needs today's key mints it (32 random bytes,
 *     `INSERT … ON CONFLICT DO NOTHING`) and every instance then reads the
 *     one that won;
 *   - the gateway's GC deletes a key two days after its day ended
 *     (gc.ts), and with it the means to reverse anything hashed under it.
 *
 * Why not a secret in the gateway's env: the gateway holds exactly one
 * credential there (epic #763), and a key that never changes would make
 * every hash ever stored reversible for whoever obtains it once. Why not a
 * key per instance: instances would then keep separate buckets, multiplying
 * every rate limit by the number of instances.
 *
 * At midnight UTC the key changes, so every bucket starts over once a day;
 * the limits' windows are minutes, so that costs at most one window.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-ip-hash-key",
};

/** The key epoch of `nowMs`: days since 1970-01-01 UTC (migration 0500). */
export function ipHashKeyEpoch(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

/** Hands out the current IP-hash key, minting and caching it per day. */
export interface IpHashKeys {
  /** Today's key (32 bytes). */
  current(): Promise<Uint8Array>;
}

/**
 * The key store on `adapter`. Cached in memory for its day: one database
 * round trip per instance and day.
 */
export function ipHashKeys(adapter: DatabaseAdapter, now: () => number = Date.now): IpHashKeys {
  let cached: { epoch: number; key: Uint8Array } | null = null;
  let inFlight: Promise<Uint8Array> | null = null;
  return {
    async current() {
      const epoch = ipHashKeyEpoch(now());
      if (cached?.epoch === epoch) return cached.key;
      if (inFlight) return inFlight;
      inFlight = loadOrMint(adapter, epoch)
        .then((key) => {
          cached = { epoch, key };
          return key;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

async function loadOrMint(adapter: DatabaseAdapter, epoch: number): Promise<Uint8Array> {
  const candidate = crypto.getRandomValues(new Uint8Array(32));
  const rows = await adapter.withPublicTransaction(SYSTEM_CTX, async (tx) => {
    await tx.execute(sql`
      INSERT INTO gateway_ip_hash_keys (epoch, key)
      VALUES (${epoch}, decode(${Buffer.from(candidate).toString("hex")}, 'hex'))
      ON CONFLICT (epoch) DO NOTHING
    `);
    return (await tx.execute(sql`
      SELECT encode(key, 'hex') AS key FROM gateway_ip_hash_keys WHERE epoch = ${epoch}
    `)) as unknown as { key: string }[];
  });
  const hex = rows[0]?.key;
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      `the gateway's IP-hash key for day ${epoch} could not be read back from gateway_ip_hash_keys; run the cms_public migrations (0500 creates the table)`,
    );
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
