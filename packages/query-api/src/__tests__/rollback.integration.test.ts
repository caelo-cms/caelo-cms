// SPDX-License-Identifier: MPL-2.0

/**
 * Transaction rollback + rate-limit-hook integration tests.
 *   1. Handler that throws after a partial write rolls back the whole txn.
 *   2. NULL actor_id fails (NOT NULL + RLS regression anchor).
 *   3. RateLimiter stub short-circuits the handler when non-null; default
 *      allow-all limiter is invisible.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  DatabaseAdapter,
  defineOperation,
  type ExecuteOptions,
  execute,
  OperationRegistry,
} from "../index.js";
import { deleteActors, seedActors } from "./_seed.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const actorId = "00000000-0000-0000-0000-000000000030";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  await seedActors(adapter.rawAdmin(), [
    { id: actorId, kind: "system", displayName: "rollback-test" },
  ]);

  registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "rollback.write_then_throw",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({}),
      handler: async (ctx, _input, tx) => {
        await tx.execute(sql`
          INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
          VALUES (${ctx.actorId}::uuid, 'rollback.write_then_throw', 'partial', true)
        `);
        throw new Error("simulated mid-op crash");
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "rollback.count_mine",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      handler: async (_ctx, _input, tx) => {
        const rows = (await tx.execute(
          sql`SELECT count(*)::int as c FROM audit_events WHERE operation = 'rollback.write_then_throw'`,
        )) as unknown as { c: number }[];
        const first = rows[0];
        if (!first) {
          return err({ kind: "HandlerError", operation: "rollback.count_mine", message: "no row" });
        }
        return ok({ count: first.c });
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "rollback.null_actor_id",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({}),
      handler: async (_ctx, _input, tx) => {
        // NOT NULL + RLS must both reject a NULL actor_id. We cast NULL to uuid
        // so the type system doesn't catch it — Postgres should.
        await tx.execute(sql`
          INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
          VALUES (NULL::uuid, 'rollback.null_actor_id', 'x', true)
        `);
        return ok({});
      },
    }),
  );
});

afterAll(async () => {
  await deleteActors(adapter.rawAdmin(), [actorId]);
  await adapter.close();
});

const ctx: ExecutionContext = { actorId, actorKind: "system", requestId: "rollback-test" };

describe("transaction rollback", () => {
  it("handler that throws after a write rolls back — no partial row persists", async () => {
    const attempt = await execute(registry, adapter, ctx, "rollback.write_then_throw", {});
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.kind).toBe("HandlerError");

    const count = await execute(registry, adapter, ctx, "rollback.count_mine", {});
    expect(count.ok).toBe(true);
    if (count.ok) expect((count.value as { count: number }).count).toBe(0);
  });

  it("NULL actor_id is rejected (NOT NULL + RLS regression anchor)", async () => {
    const attempt = await execute(registry, adapter, ctx, "rollback.null_actor_id", {});
    expect(attempt.ok).toBe(false);
  });
});

describe("rate-limit hook", () => {
  it("a limiter that returns RateLimited is honoured and short-circuits the handler", async () => {
    const options: ExecuteOptions = {
      rateLimiter: {
        async check(_c, name) {
          return { kind: "RateLimited", operation: name, retryAfterMs: 250 };
        },
      },
    };
    const result = await execute(registry, adapter, ctx, "rollback.count_mine", {}, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("RateLimited");
  });

  it("the default stub limiter allows everything", async () => {
    const result = await execute(registry, adapter, ctx, "rollback.count_mine", {});
    expect(result.ok).toBe(true);
  });
});
