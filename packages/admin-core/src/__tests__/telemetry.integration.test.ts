// SPDX-License-Identifier: MPL-2.0

/**
 * Telemetry consent surface. The "Test send" payload is what the Owner
 * audits before opting in, so it must carry exactly the fields that
 * docs/TELEMETRY.md and the /settings/ai/telemetry text promise: installId,
 * Caelo version and the three counts. It once also carried 30-day AI spend,
 * which the policy rules out ("no AI usage data"), and lacked the version
 * the page promised. Real Postgres (§6).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { CAELO_VERSION, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "telemetry-test",
};
const HUMAN: ExecutionContext = { ...SYSTEM, actorKind: "human" };
const AI: ExecutionContext = { ...SYSTEM, actorKind: "ai" };

async function reset(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE telemetry_settings SET install_id = NULL,
        install_ping_enabled = false, error_reporting_enabled = false WHERE id = 1`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await adapter.close();
});

describe("telemetry", () => {
  it("the test payload carries only what the consent text lists", async () => {
    const r = await execute(registry, adapter, HUMAN, "telemetry.test_send", {});
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { payload } = r.value as { payload: Record<string, unknown> };
    expect(Object.keys(payload).sort()).toEqual(
      ["caeloVersion", "counts", "emittedAt", "installId", "kind"].sort(),
    );
    expect(payload.caeloVersion).toBe(CAELO_VERSION);
    expect(Object.keys(payload.counts as object).sort()).toEqual(
      ["activePlugins", "modules", "pages"].sort(),
    );
  });

  it("the Owner's save mints the install id once and keeps it", async () => {
    const first = await execute(registry, adapter, HUMAN, "telemetry.set", {
      installPingEnabled: true,
      errorReportingEnabled: false,
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const id = (first.value as { installId: string | null }).installId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const second = await execute(registry, adapter, HUMAN, "telemetry.set", {
      installPingEnabled: true,
      errorReportingEnabled: true,
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect((second.value as { installId: string | null }).installId).toBe(id);
  });

  it("the AI cannot opt the install in", async () => {
    const r = await execute(registry, adapter, AI, "telemetry.set", {
      installPingEnabled: true,
      errorReportingEnabled: true,
    });
    expect(r.ok).toBe(false);
  });
});
