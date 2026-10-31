// SPDX-License-Identifier: MPL-2.0

/**
 * A handler that catches a failed statement leaves an aborted transaction,
 * and Postgres answers the adapter's COMMIT with a rollback. Bun >= 1.4.4
 * reports that as a throw (`ERR_POSTGRES_COMMIT_ROLLED_BACK`); before, it
 * was silent. The propose ops rely on the handler's own error reaching the
 * caller ("Identical proposal already pending"), so:
 *   1. a handler error on an aborted transaction is returned as-is;
 *   2. a handler that answers ok on an aborted transaction is a loud error,
 *      never a success whose writes were silently dropped.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "../index.js";
import { deleteActors, seedActors } from "./_seed.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const actorId = "00000000-0000-0000-0000-000000000031";
const ctx: ExecutionContext = { actorId, actorKind: "system", requestId: "aborted-tx-test" };

/** Fails inside the transaction, as a unique violation does. */
async function failStatement(tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2]) {
  try {
    await tx.execute(sql`SELECT 1 / 0`);
  } catch {
    // The handler decides what to answer; the transaction is aborted now.
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  await seedActors(adapter.rawAdmin(), [
    { id: actorId, kind: "system", displayName: "aborted-tx-test" },
  ]);
  registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "aborted_tx.catch_then_err",
      readScope: "request",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({}),
      handler: async (_ctx, _input, tx) => {
        await failStatement(tx);
        return err({
          kind: "HandlerError",
          operation: "aborted_tx.catch_then_err",
          message: "Identical proposal already pending",
        });
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "aborted_tx.catch_then_ok",
      readScope: "request",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({}),
      handler: async (_ctx, _input, tx) => {
        await failStatement(tx);
        return ok({});
      },
    }),
  );
});

afterAll(async () => {
  await deleteActors(adapter.rawAdmin(), [actorId]);
  await adapter.close();
});

describe("a handler that leaves an aborted transaction", () => {
  it("returns the handler's own error, not the rolled-back COMMIT", async () => {
    const result = await execute(registry, adapter, ctx, "aborted_tx.catch_then_err", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        kind: "HandlerError",
        message: "Identical proposal already pending",
      });
    }
  });

  it("is an error, never a success, when the handler answered ok", async () => {
    const result = await execute(registry, adapter, ctx, "aborted_tx.catch_then_ok", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(JSON.stringify(result.error)).toContain("ERR_POSTGRES_COMMIT_ROLLED_BACK");
  });
});
