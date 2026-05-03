// SPDX-License-Identifier: MPL-2.0

/**
 * Exercise the production `cms_public` code path using `public_role` — the role
 * the API Gateway actually holds at runtime. The main RLS adversarial matrix
 * runs as admin_role (via PUBLIC_ADMIN_DATABASE_URL) because FORCE RLS catches
 * it either way, but we want at least one end-to-end test on the real role so
 * a future GRANT regression is caught here, not in P13 against a live gateway.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "../index.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_ROLE_URL = process.env["PUBLIC_DATABASE_URL"]; // public_role -> cms_public
const PUBLIC_ADMIN_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"]; // admin_role -> cms_public (cleanup only)
if (!ADMIN_URL || !PUBLIC_ROLE_URL || !PUBLIC_ADMIN_URL) {
  throw new Error("ADMIN_DATABASE_URL + PUBLIC_DATABASE_URL + PUBLIC_ADMIN_DATABASE_URL required");
}

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ROLE_URL,
  });

  registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "public_role.sentinel.insert",
      actorScope: ["plugin", "system"],
      database: "cms_public",
      input: z.object({ payload: z.string() }),
      output: z.object({}),
      handler: async (ctx, input, tx) => {
        await tx.execute(sql`
          INSERT INTO rls_sentinel (plugin_id, payload) VALUES (${ctx.pluginId ?? ""}, ${input.payload})
        `);
        return ok({});
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "public_role.sentinel.count_mine",
      actorScope: ["plugin", "system"],
      database: "cms_public",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      handler: async (_ctx, _input, tx) => {
        const rows = (await tx.execute(
          sql`SELECT count(*)::int as c FROM rls_sentinel`,
        )) as unknown as { c: number }[];
        return ok({ count: rows[0]?.c ?? 0 });
      },
    }),
  );
});

afterAll(async () => {
  // public_role has INSERT + SELECT on rls_sentinel but not DELETE. Clean up
  // via a dedicated admin_role-on-cms_public connection.
  const admin = new SQL(PUBLIC_ADMIN_URL);
  try {
    await admin.unsafe(`DELETE FROM rls_sentinel WHERE plugin_id = 'public_role_test'`);
  } finally {
    await admin.end();
  }
  await adapter.close();
});

describe("cms_public via public_role (production path)", () => {
  const pluginCtx: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-000000000040",
    actorKind: "plugin",
    pluginId: "public_role_test",
    requestId: "pr-1",
  };

  it("INSERT + SELECT round-trip succeed when pluginId matches the session setting", async () => {
    const insert = await execute(registry, adapter, pluginCtx, "public_role.sentinel.insert", {
      payload: "hello from public_role",
    });
    expect(insert.ok).toBe(true);

    const count = await execute(
      registry,
      adapter,
      pluginCtx,
      "public_role.sentinel.count_mine",
      {},
    );
    expect(count.ok).toBe(true);
    if (count.ok) expect((count.value as { count: number }).count).toBeGreaterThan(0);
  });
});
