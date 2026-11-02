// SPDX-License-Identifier: MPL-2.0

/**
 * #1338 — the rotating key of the client-address hashes, against the real
 * cms_public as the gateway's own login (public_role).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { hashClientAddress } from "./client-ip.js";
import { GATEWAY_DATABASE_ROLES } from "./database-env.js";
import { ipHashKeyEpoch, ipHashKeys } from "./ip-hash-key.js";

const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!PUBLIC_URL) throw new Error("PUBLIC_DATABASE_URL required");

const DAY = 24 * 60 * 60 * 1000;
let adapter: DatabaseAdapter;

beforeAll(() => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: PUBLIC_URL,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
});

afterAll(async () => {
  await adapter.close();
});

describe("gateway IP-hash keys (#1338)", () => {
  it("two instances agree on today's key, so their buckets agree", async () => {
    const now = Date.now();
    const a = await ipHashKeys(adapter, () => now).current();
    const b = await ipHashKeys(adapter, () => now).current();
    expect(a).toHaveLength(32);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    expect(hashClientAddress("198.51.100.7", a)).toBe(hashClientAddress("198.51.100.7", b));
  });

  it("rotates with the day: tomorrow's key hashes the same address differently", async () => {
    let now = Date.now();
    const keys = ipHashKeys(adapter, () => now);
    const today = await keys.current();
    now += DAY;
    const tomorrow = await keys.current();
    expect(Buffer.from(tomorrow).equals(Buffer.from(today))).toBe(false);
    expect(hashClientAddress("198.51.100.7", tomorrow)).not.toBe(
      hashClientAddress("198.51.100.7", today),
    );
  });

  it("an instance whose clock lags a day uses the database's today, not a back-dated key", async () => {
    const today = await ipHashKeys(adapter).current();
    const lagging = await ipHashKeys(adapter, () => Date.now() - DAY).current();
    expect(Buffer.from(lagging).equals(Buffer.from(today))).toBe(true);
  });

  it("refuses a back-dated key, even yesterday's, so nobody can plant one for hashes already stored", async () => {
    const epoch = ipHashKeyEpoch(Date.now()) - 1;
    await expect(
      adapter.withPublicTransaction(
        { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "t" },
        async (tx) => {
          await tx.execute(sql`INSERT INTO gateway_ip_hash_keys (epoch, key)
                               VALUES (${epoch}, decode(repeat('ab', 32), 'hex'))`);
        },
      ),
    ).rejects.toThrow();
  });
});
