// SPDX-License-Identifier: MPL-2.0

/**
 * #1154 — the login rate-limit GC moved out of the redeploy orchestrator
 * into its own worker. It deletes buckets that expired more than an hour
 * ago and nothing else (a recently expired bucket may still be read by a
 * login racing the sweep).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sweepExpiredRateLimitBuckets } from "./rate-limit-gc-worker.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const PFX = "t1154-gc-";
let adapter: DatabaseAdapter;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
});

afterAll(async () => {
  await asSystem((tx) => tx`DELETE FROM rate_limit_buckets WHERE key LIKE ${`${PFX}%`}`);
  await adapter.close();
});

describe("sweepExpiredRateLimitBuckets", () => {
  it("deletes buckets expired over an hour ago and keeps the rest", async () => {
    await asSystem(async (tx) => {
      await tx`INSERT INTO rate_limit_buckets (key, expires_at) VALUES
        (${`${PFX}old`}, now() - interval '2 hours'),
        (${`${PFX}recent`}, now() - interval '10 minutes'),
        (${`${PFX}live`}, now() + interval '10 minutes')`;
    });
    await sweepExpiredRateLimitBuckets(adapter);
    const keys = await asSystem(
      async (tx) =>
        (await tx`SELECT key FROM rate_limit_buckets WHERE key LIKE ${`${PFX}%`} ORDER BY key`) as {
          key: string;
        }[],
    );
    expect(keys.map((k) => k.key)).toEqual([`${PFX}live`, `${PFX}recent`]);
  });
});
