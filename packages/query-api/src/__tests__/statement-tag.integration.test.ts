// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — every Database Adapter transaction carries its holder in
 * `application_name` (statement-tag.ts), so the query index gate can tell
 * an operation's statements (and the trigger statements they fire) from
 * test-fixture SQL on the raw pools.
 *
 *   - a write op, a read op and a `withPublicTransaction` holder each see
 *     their own tag inside the transaction;
 *   - the tag is LOCAL: after the commit, raw-pool SQL on the same
 *     connections runs untagged, which is what keeps fixture SQL out of
 *     the gate.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  DatabaseAdapter,
  defineOperation,
  defineReadOperation,
  execute,
  OperationRegistry,
  type TransactionRunner,
} from "../index.js";
import { transactionTag } from "../statement-tag.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001293",
  actorKind: "system",
  requestId: "statement-tag-test",
};

const appName = async (tx: TransactionRunner): Promise<string> => {
  const rows = (await tx.execute(
    sql`SELECT current_setting('application_name') AS a`,
  )) as unknown as { a: string }[];
  return rows[0]?.a ?? "";
};

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();

beforeAll(() => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
    poolMax: 2,
  });
  registry.register(
    defineOperation({
      name: "test.tag_write",
      readScope: "request",
      database: "cms_admin",
      actorScope: ["system"],
      input: z.object({}).strict(),
      output: z.object({ tag: z.string() }),
      handler: async (_c, _i, tx) => ok({ tag: await appName(tx) }),
    }),
  );
  registry.register(
    defineReadOperation({
      name: "test.tag_read",
      readScope: "request",
      actorScope: ["system"],
      input: z.object({}).strict(),
      output: z.object({ tag: z.string() }),
      handler: async (_c, _i, reads) => ok({ tag: await reads.read(appName) }),
    }),
  );
});

afterAll(async () => {
  await adapter.close();
});

describe("transaction tag (#1293)", () => {
  it("names the operation inside a write op's transaction", async () => {
    const r = await execute(registry, adapter, ctx, "test.tag_write", {});
    expect(r.ok && r.value.tag).toBe("caelo/test.tag_write");
  });

  it("names the operation inside a read op's short reads", async () => {
    const r = await execute(registry, adapter, ctx, "test.tag_read", {});
    expect(r.ok && r.value.tag).toBe("caelo/test.tag_read");
  });

  it("names the holder label of a cms_public transaction", async () => {
    const tag = await adapter.withPublicTransaction(ctx, appName, { holder: "test.public_holder" });
    expect(tag).toBe("caelo/test.public_holder");
  });

  it("is LOCAL: raw-pool SQL after the commit runs untagged", async () => {
    for (let i = 0; i < 4; i++) await execute(registry, adapter, ctx, "test.tag_write", {});
    const raw = adapter.rawAdmin();
    const rows = (await Promise.all(
      [0, 1].map(() => raw`SELECT current_setting('application_name') AS a`),
    )) as unknown as { a: string }[][];
    for (const r of rows) expect(r[0]?.a.startsWith("caelo/")).toBe(false);
  });

  it("fits Postgres's application_name limit and stays printable ASCII", () => {
    const tag = transactionTag(`plugin_storage.list/${"x".repeat(80)}ü`);
    expect(tag.length).toBe(63);
    expect(transactionTag("aüb")).toBe("caelo/a?b");
  });
});
