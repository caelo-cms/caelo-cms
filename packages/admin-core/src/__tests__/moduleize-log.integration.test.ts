// SPDX-License-Identifier: MPL-2.0

/**
 * ai_moduleize.log_attempt writes one telemetry row (real Postgres, FORCE RLS).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "moduleize-log",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM ai_moduleize_attempts WHERE input_html LIKE 'MZLOG-%'`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});
afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("ai_moduleize.log_attempt", () => {
  it("persists an ok_after_repair row with errors + final fields", async () => {
    const r = await execute(registry, adapter, SYS, "ai_moduleize.log_attempt", {
      inputHtml: "MZLOG-<h1>x</h1>",
      fieldsHint: null,
      attempts: 2,
      errors: ["placeholder {{ghost}} references undeclared field \"ghost\""],
      outcome: "ok_after_repair",
      finalFields: [{ name: "hero_title", kind: "text", label: "Hero Title" }],
      model: "claude-sonnet-5",
      costMicrocents: 1234,
    });
    expect(r.ok).toBe(true);

    const sql = new SQL(ADMIN_URL!);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`SELECT attempts, outcome, cost_microcents, errors, final_fields
          FROM ai_moduleize_attempts WHERE input_html = 'MZLOG-<h1>x</h1>'`;
      })) as unknown as {
        attempts: number;
        outcome: string;
        cost_microcents: number;
        errors: unknown;
        final_fields: unknown;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe("ok_after_repair");
      expect(rows[0]?.attempts).toBe(2);
      expect(Number(rows[0]?.cost_microcents)).toBe(1234);
    } finally {
      await sql.end();
    }
  });

  it("the CHECK rejects a first-try (attempts < 2) row — only retries are logged", async () => {
    const r = await execute(registry, adapter, SYS, "ai_moduleize.log_attempt", {
      inputHtml: "MZLOG-should-fail",
      attempts: 1,
      errors: [],
      outcome: "ok_after_repair",
      model: "m",
    });
    expect(r.ok).toBe(false);
  });
});
