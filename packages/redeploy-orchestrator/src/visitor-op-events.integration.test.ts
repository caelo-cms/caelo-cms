// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 review — the redeploy orchestrator's watermark over
 * cms_public `gateway_plugin_op_events`, against a real Postgres:
 *
 *   - an event whose id was taken before a committed one, but which
 *     commits later, is still read (the watermark stops at the open gap);
 *   - the watermark never passes the sequence's last value.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { commitVisitorWatermark, readVisitorOpEvents } from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OP = "t635-orch.submit";
const PLUGIN = "11111111-2222-4333-8444-555555555555";
const HASH = "b".repeat(64);
let adapter: DatabaseAdapter;
let gateway: SQL;

/** Insert one event as the gateway does (public_role, payload columns only). */
async function gatewayInsert(on: SQL, entity: string): Promise<void> {
  await on`INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, entity_id)
           VALUES (${PLUGIN}::uuid, ${OP}, ${HASH}, true, ${entity}::uuid)`;
}

async function watermark(): Promise<string> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    const rows = (await conn`SELECT auto_redeploy_last_public_event_id::text AS id
                             FROM site_settings WHERE id = 1`) as { id: string }[];
    return rows[0]?.id ?? "0";
  } finally {
    await conn.end();
  }
}

beforeAll(() => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  gateway = new SQL(PUBLIC_URL as string);
});

beforeEach(async () => {
  // Start every case at the sequence's current value. The suite's per-file
  // reset truncates cms_public with RESTART IDENTITY, which a real install
  // never does, so a watermark left by an earlier file may be ahead of it.
  const conn = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    const [row] = (await conn`
      SELECT COALESCE(pg_sequence_last_value('gateway_plugin_op_events_id_seq'::regclass), 0)::text
        AS last`) as { last: string }[];
    await commitVisitorWatermark(adapter, row?.last ?? "0");
  } finally {
    await conn.end();
  }
});

afterAll(async () => {
  await gateway.end();
  await adapter.close();
});

describe("visitor-event watermark (#635 review)", () => {
  it("reads an event that commits after a higher id was read", async () => {
    const slowConn = await gateway.reserve();
    try {
      await slowConn`BEGIN`;
      await gatewayInsert(slowConn, "00000000-0000-4000-8000-000000000001");
      await gatewayInsert(gateway, "00000000-0000-4000-8000-000000000002");

      const before = await watermark();
      const first = await readVisitorOpEvents(adapter, [OP]);
      // The committed event sits behind an open gap: nothing moves yet.
      expect(first.events).toEqual([]);
      expect(first.lastId).toBeNull();

      await slowConn`COMMIT`;
      const second = await readVisitorOpEvents(adapter, [OP]);
      expect(second.events.map((e) => e.entity_id)).toEqual([
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ]);
      expect(BigInt(second.lastId ?? "0")).toBeGreaterThan(BigInt(before));
    } finally {
      slowConn.release();
    }
  });

  it("never moves past the sequence's last value", async () => {
    await gatewayInsert(gateway, "00000000-0000-4000-8000-000000000003");
    const read = await readVisitorOpEvents(adapter, [OP]);
    expect(read.lastId).not.toBeNull();
    const conn = new SQL(PUBLIC_ADMIN_URL as string);
    try {
      const [row] = (await conn`
        SELECT pg_sequence_last_value('gateway_plugin_op_events_id_seq'::regclass)::text AS last`) as {
        last: string;
      }[];
      expect(BigInt(read.lastId ?? "0")).toBeLessThanOrEqual(BigInt(row?.last ?? "0"));
    } finally {
      await conn.end();
    }
  });
});
