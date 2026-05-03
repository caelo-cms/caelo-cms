// SPDX-License-Identifier: MPL-2.0

/**
 * Integration test: happy-path round-trip through the whole Query API stack
 * against a real PostgreSQL instance. Requires the compose stack to be running
 * and migrations applied.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "../index.js";
import { deleteActors, seedActors } from "./_seed.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL + PUBLIC_ADMIN_DATABASE_URL must be set for integration tests",
  );
}

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const systemActorId = "00000000-0000-0000-0000-000000000001";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  await seedActors(adapter.rawAdmin(), [
    { id: systemActorId, kind: "system", displayName: "integration-test-system" },
  ]);

  registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "test.audit.record",
      actorScope: ["human", "system"],
      database: "cms_admin",
      input: z.object({
        operation: z.string(),
        inputHash: z.string(),
        succeeded: z.boolean(),
      }),
      output: z.object({ id: z.string() }),
      handler: async (ctx, input, tx) => {
        const rows = (await tx.execute(sql`
          INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
          VALUES (${ctx.actorId}::uuid, ${input.operation}, ${input.inputHash}, ${input.succeeded})
          RETURNING id
        `)) as unknown as { id: string }[];
        const first = rows[0];
        if (!first) {
          return err({ kind: "HandlerError", operation: "test.audit.record", message: "no row" });
        }
        return ok({ id: first.id });
      },
    }),
  );
});

afterAll(async () => {
  await deleteActors(adapter.rawAdmin(), [systemActorId]);
  await adapter.close();
});

const ctx: ExecutionContext = {
  actorId: systemActorId,
  actorKind: "system",
  requestId: "test-req",
};

describe("execute() — happy path", () => {
  it("validates, runs, commits, returns Ok with the new row id", async () => {
    const result = await execute(registry, adapter, ctx, "test.audit.record", {
      operation: "demo.op",
      inputHash: "abc123",
      succeeded: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof (result.value as { id: string }).id).toBe("string");
    }
  });

  it("returns Err('UnknownOperation') for an unregistered name", async () => {
    const result = await execute(registry, adapter, ctx, "nope.nope", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("UnknownOperation");
  });

  it("returns Err('ValidationFailed') for bad input shape", async () => {
    const result = await execute(registry, adapter, ctx, "test.audit.record", {
      operation: 42,
      inputHash: true,
      succeeded: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("ValidationFailed");
  });

  it("returns Err('ActorScopeRejected') for an out-of-scope actor kind", async () => {
    const aiCtx: ExecutionContext = { ...ctx, actorKind: "ai" };
    const result = await execute(registry, adapter, aiCtx, "test.audit.record", {
      operation: "demo.op",
      inputHash: "abc123",
      succeeded: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("ActorScopeRejected");
  });
});
