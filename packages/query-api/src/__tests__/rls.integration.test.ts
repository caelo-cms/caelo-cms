// SPDX-License-Identifier: MPL-2.0

/**
 * RLS adversarial matrix. Every test here must fail closed at the Postgres layer —
 * an app-level check that happens to catch it is not enough.
 *
 * Four cases:
 *   1. Editor reads Owner audit_event → 0 rows (USING filters).
 *   2. Editor writes audit_event with spoofed actor_id → WITH CHECK rejects.
 *   3. Plugin A tries to INSERT into rls_sentinel claiming plugin B → WITH CHECK rejects.
 *   4. Plugin A tries to SELECT Plugin B's existing rows → 0 rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "../index.js";
import { deleteActors, seedActors } from "./_seed.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const ownerId = "00000000-0000-0000-0000-000000000010";
const editorId = "00000000-0000-0000-0000-000000000020";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  // Seed two human actors. RLS policies don't care about kind here — they scope by
  // actor_id. This proves peers of the same kind can't see each other's rows.
  await seedActors(adapter.rawAdmin(), [
    { id: ownerId, kind: "human", displayName: "owner" },
    { id: editorId, kind: "human", displayName: "editor" },
  ]);

  registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "audit.record_for_self",
      actorScope: ["human", "system"],
      database: "cms_admin",
      input: z.object({ operation: z.string() }),
      output: z.object({ count: z.number() }),
      handler: async (ctx, input, tx) => {
        const txD = tx as unknown as { execute: (s: ReturnType<typeof sql>) => Promise<unknown> };
        await txD.execute(sql`
          INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
          VALUES (${ctx.actorId}::uuid, ${input.operation}, 'x', true)
        `);
        return ok({ count: 1 });
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "audit.record_spoofing_another_actor",
      actorScope: ["human", "system"],
      database: "cms_admin",
      input: z.object({ spoofActorId: z.string() }),
      output: z.object({}),
      handler: async (_ctx, input, tx) => {
        const txD = tx as unknown as { execute: (s: ReturnType<typeof sql>) => Promise<unknown> };
        await txD.execute(sql`
          INSERT INTO audit_events (actor_id, operation, input_hash, succeeded)
          VALUES (${input.spoofActorId}::uuid, 'spoof', 'x', true)
        `);
        return ok({});
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "audit.count_mine",
      actorScope: ["human", "system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      handler: async (_ctx, _input, tx) => {
        const txD = tx as unknown as { execute: (s: ReturnType<typeof sql>) => Promise<unknown> };
        const rows = (await txD.execute(
          sql`SELECT count(*)::int as c FROM audit_events`,
        )) as unknown as {
          c: number;
        }[];
        const first = rows[0];
        if (!first)
          return err({ kind: "HandlerError", operation: "audit.count_mine", message: "no row" });
        return ok({ count: first.c });
      },
    }),
  );

  registry.register(
    defineOperation({
      name: "sentinel.insert",
      actorScope: ["plugin", "system"],
      database: "cms_public",
      input: z.object({ claimedPluginId: z.string(), payload: z.string() }),
      output: z.object({}),
      handler: async (_ctx, input, tx) => {
        const txD = tx as unknown as { execute: (s: ReturnType<typeof sql>) => Promise<unknown> };
        await txD.execute(sql`
          INSERT INTO rls_sentinel (plugin_id, payload) VALUES (${input.claimedPluginId}, ${input.payload})
        `);
        return ok({});
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "sentinel.count_visible",
      actorScope: ["plugin", "system"],
      database: "cms_public",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      handler: async (_ctx, _input, tx) => {
        const txD = tx as unknown as { execute: (s: ReturnType<typeof sql>) => Promise<unknown> };
        const rows = (await txD.execute(
          sql`SELECT count(*)::int as c FROM rls_sentinel`,
        )) as unknown as {
          c: number;
        }[];
        const first = rows[0];
        if (!first)
          return err({
            kind: "HandlerError",
            operation: "sentinel.count_visible",
            message: "no row",
          });
        return ok({ count: first.c });
      },
    }),
  );
});

afterAll(async () => {
  await deleteActors(adapter.rawAdmin(), [ownerId, editorId]);
  await adapter
    .rawPublic()
    .unsafe(`DELETE FROM rls_sentinel WHERE plugin_id IN ('plugin_A','plugin_B')`);
  await adapter.close();
});

describe("cms_admin per-actor RLS", () => {
  const ownerCtx: ExecutionContext = { actorId: ownerId, actorKind: "human", requestId: "r1" };
  const editorCtx: ExecutionContext = { actorId: editorId, actorKind: "human", requestId: "r2" };

  it("(1) editor cannot read owner's audit_event rows — USING filters them to zero", async () => {
    await execute(registry, adapter, ownerCtx, "audit.record_for_self", {
      operation: "owner-only",
    });
    const editorVisible = await execute(registry, adapter, editorCtx, "audit.count_mine", {});
    expect(editorVisible.ok).toBe(true);
    if (editorVisible.ok) expect((editorVisible.value as { count: number }).count).toBe(0);
  });

  it("(2) editor cannot write an audit_event spoofing owner's actor_id — WITH CHECK denies", async () => {
    const spoofed = await execute(
      registry,
      adapter,
      editorCtx,
      "audit.record_spoofing_another_actor",
      {
        spoofActorId: ownerId,
      },
    );
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.error.kind).toBe("RLSDenied");
  });
});

describe("cms_public per-plugin RLS", () => {
  const pluginA: ExecutionContext = {
    actorId: ownerId,
    actorKind: "plugin",
    pluginId: "plugin_A",
    requestId: "r3",
  };
  const pluginB: ExecutionContext = {
    actorId: editorId,
    actorKind: "plugin",
    pluginId: "plugin_B",
    requestId: "r4",
  };

  it("(3) plugin A cannot INSERT into rls_sentinel claiming plugin_id='plugin_B' — WITH CHECK denies", async () => {
    const attempt = await execute(registry, adapter, pluginA, "sentinel.insert", {
      claimedPluginId: "plugin_B",
      payload: "pretending to be B",
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.kind).toBe("RLSDenied");
  });

  it("(4) plugin A cannot SELECT plugin B's existing rows — USING hides them", async () => {
    await execute(registry, adapter, pluginB, "sentinel.insert", {
      claimedPluginId: "plugin_B",
      payload: "B's own row",
    });
    const aSees = await execute(registry, adapter, pluginA, "sentinel.count_visible", {});
    expect(aSees.ok).toBe(true);
    if (aSees.ok) expect((aSees.value as { count: number }).count).toBe(0);
  });
});
