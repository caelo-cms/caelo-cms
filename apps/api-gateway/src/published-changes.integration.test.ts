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
});
