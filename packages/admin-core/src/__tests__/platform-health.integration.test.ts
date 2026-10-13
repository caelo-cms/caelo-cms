// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #696 — the migration bookkeeping reads behind the admin's deep health
 * check: they return what the migration runner recorded in each database,
 * and only the system actor may call them.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "platform-health-test",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "platform-health-test-ai",
};

const MIGRATIONS = resolve(import.meta.dir, "../../../migrations/migrations");
const shipped = (db: string) =>
  readdirSync(resolve(MIGRATIONS, db))
    .filter((f) => f.endsWith(".sql"))
    .sort();

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

describe("platform_health migration reads", () => {
  it("returns every migration the runner applied to cms_admin, sorted", async () => {
    const r = await execute(
      registry,
      adapter,
      SYSTEM,
      "platform_health.applied_admin_migrations",
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { applied } = r.value as { applied: string[] };
    // The test database is migrated from this checkout: nothing pending.
    expect(applied).toEqual(shipped("cms_admin"));
  });

  it("returns every migration the runner applied to cms_public, sorted", async () => {
    const r = await execute(
      registry,
      adapter,
      SYSTEM,
      "platform_health.applied_public_migrations",
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect((r.value as { applied: string[] }).applied).toEqual(shipped("cms_public"));
  });

  it("is closed to the AI", async () => {
    const r = await execute(registry, adapter, AI, "platform_health.applied_admin_migrations", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
  });
});
