// SPDX-License-Identifier: MPL-2.0

/**
 * #1144 — two activations of one plugin never run their seed at once,
 * across connections (the lock lives in Postgres, not in this process).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { runActivationSerialized } from "./activation-lock.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
let a: DatabaseAdapter;
let b: DatabaseAdapter;

beforeAll(() => {
  // Two adapters = two pools, as two admin instances would have.
  a = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  b = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
});

afterAll(async () => {
  await a.close();
  await b.close();
});

describe("runActivationSerialized", () => {
  it("runs a check-then-insert seed of one plugin once at a time", async () => {
    let rows = 0;
    const seed = async () => {
      const seen = rows;
      await new Promise((r) => setTimeout(r, 150));
      if (seen === 0) rows += 1;
    };
    await Promise.all([
      runActivationSerialized({ adapter: a }, SYSTEM_ACTOR_ID, "t1144-plugin", seed),
      runActivationSerialized({ adapter: b }, SYSTEM_ACTOR_ID, "t1144-plugin", seed),
    ]);
    expect(rows).toBe(1);
  });

  it("does not serialize different plugins", async () => {
    const order: string[] = [];
    const slow = async () => {
      order.push("slow:start");
      await new Promise((r) => setTimeout(r, 300));
      order.push("slow:end");
    };
    const fast = async () => {
      order.push("fast");
    };
    const first = runActivationSerialized({ adapter: a }, SYSTEM_ACTOR_ID, "t1144-a", slow);
    await new Promise((r) => setTimeout(r, 50));
    await runActivationSerialized({ adapter: b }, SYSTEM_ACTOR_ID, "t1144-b", fast);
    await first;
    expect(order).toEqual(["slow:start", "fast", "slow:end"]);
  });
});
