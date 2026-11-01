// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 acceptance demo — DELIBERATELY BAD, removed in the next commit:
 * an op that filters media_assets on original_name, which no index covers.
 * The query index gate must fail on it, and on the unindexed FK below.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "../index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001293",
  actorKind: "system",
  requestId: "query-index-gate-demo",
};

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry.register(
    defineOperation({
      name: "demo.unindexed_lookup",
      readScope: "request",
      database: "cms_admin",
      actorScope: ["system"],
      input: z.object({ name: z.string() }).strict(),
      output: z.object({ n: z.number() }),
      handler: async (_c, input, tx) => {
        const rows = (await tx.execute(
          sql`SELECT count(*)::int AS n FROM media_assets WHERE original_name = ${input.name}`,
        )) as unknown as { n: number }[];
        return ok({ n: rows[0]?.n ?? 0 });
      },
    }),
  );
});

afterAll(async () => {
  await adapter.close();
});

describe("query index gate demo (#1293)", () => {
  it("runs an op that filters an unindexed column", async () => {
    const r = await execute(registry, adapter, ctx, "demo.unindexed_lookup", { name: "x.png" });
    expect(r.ok).toBe(true);
  });
});
