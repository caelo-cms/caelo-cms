// SPDX-License-Identifier: MPL-2.0

/**
 * RLS adversarial matrix for cms_admin per-actor policies. Every test here
 * must fail closed at the Postgres layer.
 *
 * The cms_public per-plugin cases are encoded in the reusable
 * `rlsAdversarialMatrix` helper (see rls-matrix.ts) and applied to
 * `rls_sentinel` in this file. The same helper will run against every
 * plugin-registered table in P11.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "../index.js";
import { deleteActors, seedActors } from "./_seed.js";
import { rlsAdversarialMatrix } from "./rls-matrix.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const ownerId = "00000000-0000-0000-0000-000000000010";
const editorId = "00000000-0000-0000-0000-000000000020";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
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
        await tx.execute(sql`
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
        await tx.execute(sql`
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
        const rows = (await tx.execute(
          sql`SELECT count(*)::int as c FROM audit_events`,
        )) as unknown as { c: number }[];
        return ok({ count: rows[0]?.c ?? 0 });
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
      { spoofActorId: ownerId },
    );
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.error.kind).toBe("RLSDenied");
  });
});

// Per-plugin adversarial matrix against rls_sentinel via the reusable helper.
// P11 will reuse this same function against every plugin table.
rlsAdversarialMatrix({
  label: "cms_public per-plugin RLS on rls_sentinel",
  table: "rls_sentinel",
  pluginIdColumn: "plugin_id",
  insertSqlTemplate: (pluginIdBind) =>
    `INSERT INTO rls_sentinel (plugin_id, payload) VALUES (${pluginIdBind}, 'matrix-test')`,
  identities: {
    pluginA: {
      actorId: ownerId,
      actorKind: "plugin",
      pluginId: "plugin_A",
      requestId: "r3",
    },
    pluginB: {
      actorId: editorId,
      actorKind: "plugin",
      pluginId: "plugin_B",
      requestId: "r4",
    },
  },
  adapterFactory: () =>
    new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL }),
});
