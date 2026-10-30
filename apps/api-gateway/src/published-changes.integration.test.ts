// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the gateway's caches of published state follow the admin's
 * publish notifications, with no TTL to hide a dead LISTEN.
 *
 * Before, the gateway iterated a `notifications` property Bun's SQL does
 * not have: its LISTEN never received anything, and a 5 s TTL was the only
 * invalidation. Now nothing is cached until the LISTEN is acknowledged, and
 * every notification drops every registered cache.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, type ListenHandle } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  GATEWAY_PROJECTION_CHANNEL,
  listenForPublishedChanges,
  mayCacheRead,
  onPublishedChange,
  publishedCacheGeneration,
  publishedCacheUsable,
} from "./published-changes.js";

const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!PUBLIC_URL) throw new Error("PUBLIC_ADMIN_DATABASE_URL required");

let adapter: DatabaseAdapter;
let handle: ListenHandle | null = null;

beforeAll(() => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: PUBLIC_URL,
    expectedRoles: { admin: null, public: ["admin_role", "public_role"] },
  });
});

afterAll(async () => {
  await handle?.unlisten();
  await adapter.close();
});

describe("#1267 — gateway caches follow publish notifications", () => {
  it("caches nothing before the LISTEN is acknowledged, and drops caches on every publish", async () => {
    expect(publishedCacheUsable()).toBe(false);
    let dropped = 0;
    onPublishedChange(() => {
      dropped += 1;
    });
    handle = await listenForPublishedChanges(adapter);
    expect(publishedCacheUsable()).toBe(true);
    const afterListen = dropped;
    // A read that started before the notification must not be cached
    // after it: its result may be the state the notification replaced.
    const readStartedAt = publishedCacheGeneration();
    expect(mayCacheRead(readStartedAt)).toBe(true);

    const pub = new SQL(PUBLIC_URL);
    try {
      await pub.begin(async (tx) => {
        await tx`SELECT pg_notify(${GATEWAY_PROJECTION_CHANNEL}, 'settings')`;
      });
    } finally {
      await pub.end();
    }
    const deadline = Date.now() + 5000;
    while (dropped === afterListen && Date.now() < deadline) await Bun.sleep(20);
    expect(dropped).toBe(afterListen + 1);
    expect(mayCacheRead(readStartedAt)).toBe(false);
    expect(mayCacheRead(publishedCacheGeneration())).toBe(true);
  });

  it("reads through while the LISTEN connection is down: a publish in the gap is served at once", async () => {
    expect(publishedCacheUsable()).toBe(true);
    const admin = new SQL(PUBLIC_URL);
    const asPublisher = <T>(fn: (tx: SQL) => Promise<T>) =>
      admin.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return fn(tx as unknown as SQL);
      }) as Promise<T>;
    // A cache built like the gateway's (server.ts loadSettings).
    let cached: number | null = null;
    onPublishedChange(() => {
      cached = null;
    });
    const read = async (): Promise<number> => {
      if (cached !== null && publishedCacheUsable()) return cached;
      const startedAt = publishedCacheGeneration();
      const [row] = (await asPublisher(
        (tx) =>
          tx`SELECT count(*)::int AS n FROM published_rate_limits WHERE plugin_slug = 't1267-gap'`,
      )) as { n: number }[];
      const value = row?.n ?? -1;
      if (mayCacheRead(startedAt)) cached = value;
      return value;
    };
    const original = await read();
    try {
      expect(await read()).toBe(original);
      // The LISTEN connection drops (a network blip, a failover).
      await asPublisher(
        (tx) => tx`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                    WHERE datname = current_database() AND query LIKE 'LISTEN%'`,
      );
      const deadline = Date.now() + 5000;
      while (publishedCacheUsable() && Date.now() < deadline) await Bun.sleep(5);
      expect(publishedCacheUsable()).toBe(false);
      // A publish in the gap: its notification reaches nobody.
      await asPublisher(
        (
          tx,
        ) => tx`INSERT INTO published_rate_limits (plugin_slug, operation, per_visitor_max, window_seconds)
                   VALUES ('t1267-gap', 'ping', 1, 60)`,
      );
      // Served at once, before the subscription is back.
      expect(await read()).toBe(original + 1);
      // Re-acknowledged: caching resumes, from a fresh read.
      const back = Date.now() + 10_000;
      while (!publishedCacheUsable() && Date.now() < back) await Bun.sleep(20);
      expect(publishedCacheUsable()).toBe(true);
      expect(await read()).toBe(original + 1);
    } finally {
      await asPublisher(
        (tx) => tx`DELETE FROM published_rate_limits WHERE plugin_slug = 't1267-gap'`,
      );
      await admin.end();
    }
  });
});
