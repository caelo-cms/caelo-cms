// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — bulk variants for redirects + SEO.
 *
 * Covers the AI-facing contract: one tool call lands N writes, errors
 * roll back the batch (exercised indirectly through Zod validation),
 * filters on `redirects.list` work, and `redirects.delete_many` accepts
 * exactly one of the three input shapes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const TS = Date.now();
const PREFIX = `/p8-bulk-${TS}`;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "bulk-ops-test",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE from_path LIKE ${`${PREFIX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("redirects.create_many", () => {
  it("inserts a batch in one tx", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.create_many", {
      redirects: [
        { fromPath: `${PREFIX}/a`, toPath: `${PREFIX}/new-a`, statusCode: 301 },
        { fromPath: `${PREFIX}/b`, toPath: `${PREFIX}/new-b`, statusCode: 301 },
        { fromPath: `${PREFIX}/c`, toPath: `${PREFIX}/new-c`, statusCode: 302 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { created: number; updated: number; skipped: number };
    expect(v.created).toBe(3);
    expect(v.updated).toBe(0);
    expect(v.skipped).toBe(0);
  });

  it("re-running without upsert skips existing fromPath", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.create_many", {
      redirects: [{ fromPath: `${PREFIX}/a`, toPath: `${PREFIX}/different`, statusCode: 301 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { skipped: number }).skipped).toBe(1);
  });

  it("re-running with upsert updates existing rows", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.create_many", {
      redirects: [{ fromPath: `${PREFIX}/a`, toPath: `${PREFIX}/upserted`, statusCode: 308 }],
      upsert: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { updated: number }).updated).toBe(1);

    const list = await execute(registry, adapter, systemCtx, "redirects.list", {
      query: `${PREFIX}/a`,
    });
    if (!list.ok) throw new Error("list failed");
    const found = (
      list.value as { redirects: { fromPath: string; toPath: string }[] }
    ).redirects.find((x) => x.fromPath === `${PREFIX}/a`);
    expect(found?.toPath).toBe(`${PREFIX}/upserted`);
  });
});

describe("redirects.list filters", () => {
  it("query substring matches fromPath OR toPath", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.list", {
      query: `${PREFIX}/new-`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { redirects: { fromPath: string; toPath: string }[]; totalCount: number };
    expect(v.totalCount).toBeGreaterThanOrEqual(2);
    for (const r of v.redirects) {
      expect(`${r.fromPath} ${r.toPath}`).toContain(`${PREFIX}/new-`);
    }
  });

  it("statusCode filter narrows to one status", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.list", {
      query: PREFIX,
      statusCode: 302,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const list = (r.value as { redirects: { statusCode: number }[] }).redirects;
    expect(list.every((x) => x.statusCode === 302)).toBe(true);
  });
});

describe("redirects.delete_many", () => {
  it("requires exactly one input shape", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.delete_many", {
      redirectIds: ["00000000-0000-4000-8000-000000000001"],
      fromPaths: [`${PREFIX}/x`],
    });
    expect(r.ok).toBe(false);
  });

  it("deletes by fromPath list", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.delete_many", {
      fromPaths: [`${PREFIX}/b`, `${PREFIX}/c`],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { deleted: number }).deleted).toBe(2);
  });

  it("deletes by substring match", async () => {
    const r = await execute(registry, adapter, systemCtx, "redirects.delete_many", {
      matches: PREFIX,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
  });
});
