// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 — read operations (`defineReadOperation`) hold no
 * connection between their short reads.
 *
 *   - each `reads.read` runs under the caller's identity (RLS sees it);
 *   - the handler holds no pooled connection between reads: with a pool
 *     of 2 and more concurrent ops than connections, each awaiting a
 *     second checkout mid-handler (what a plugin storage access is), all
 *     of them finish;
 *   - a branch the caller may not see is refused before the handler runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseAdapter, defineReadOperation, execute, OperationRegistry } from "../index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001212",
  actorKind: "system",
  requestId: "read-operation-test",
};

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
let handlerRan = false;

beforeAll(() => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
    poolMax: 2,
  });
  registry.register(
    defineReadOperation({
      name: "test.read_twice",
      readScope: "request",
      actorScope: ["system", "human"],
      input: z.object({ chatBranchId: z.string().uuid().optional() }).strict(),
      output: z.object({ kinds: z.array(z.string()) }),
      handler: async (_c, _input, reads) => {
        handlerRan = true;
        const kind = () =>
          reads.read(async (tx) => {
            const rows = (await tx.execute(
              sql`SELECT current_setting('caelo.actor_kind', true) AS k`,
            )) as unknown as { k: string }[];
            return rows[0]?.k ?? "";
          });
        const first = await kind();
        // Between reads: work that takes its own connection, as a plugin
        // storage access does. Held across a transaction, this deadlocks
        // once every connection waits for another.
        const other = await adapter.withAdminTransaction(ctx, async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(0.02)`);
          return "other";
        });
        return ok({ kinds: [first, other, await kind()] });
      },
    }),
  );
});

afterAll(async () => {
  await adapter.close();
});

describe("read operations (#1212)", () => {
  it("reads under the caller's identity", async () => {
    const r = await execute(registry, adapter, ctx, "test.read_twice", {});
    expect(r.ok && r.value).toEqual({ kinds: ["system", "other", "system"] });
  });

  it("holds no connection between reads: more concurrent ops than connections finish", async () => {
    const all = Promise.all(
      Array.from({ length: 6 }, () => execute(registry, adapter, ctx, "test.read_twice", {})),
    );
    const outcome = await Promise.race([all, Bun.sleep(10_000).then(() => "deadlock" as const)]);
    expect(outcome).not.toBe("deadlock");
    for (const r of outcome as { ok: boolean }[]) expect(r.ok).toBe(true);
  });

  it("refuses a branch the caller may not see before the handler runs", async () => {
    handlerRan = false;
    const human: ExecutionContext = { ...ctx, actorKind: "human" };
    const r = await execute(registry, adapter, human, "test.read_twice", {
      chatBranchId: "00000000-0000-4000-8000-000000001212",
    });
    // No chat of this human owns the branch: it is not theirs to see.
    expect(!r.ok && r.error.kind).toBe("BranchNotFound");
    expect(handlerRan).toBe(false);
  });
});
