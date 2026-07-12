// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (2026-07-12): import_runs was intentionally excluded
 * from pending_proposals.list, so the chat's "Pending your approval"
 * strip never showed crawl proposals server-side — only the
 * optimistic in-memory push did, and any reload dropped it. The
 * operator was left hunting the mid-transcript card ("missed it
 * nearly"). 0124 adds import_runs.chat_session_id and the inbox
 * stanza; this pins both.
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

const AI = "00000000-0000-0000-0000-00000000b124";
const SOURCE_URL = "https://import-inbox-regression.example.com";

const systemCtx: ExecutionContext = {
  actorId: AI,
  actorKind: "system",
  requestId: "import-inbox-test",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_runs WHERE source_url = ${SOURCE_URL}`;
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

describe("pending_proposals.list covers import runs (0124)", () => {
  it("a proposed run appears as domain=import kind=site_import", async () => {
    const proposed = await execute(registry, adapter, systemCtx, "imports.propose_run", {
      sourceUrl: SOURCE_URL,
      depth: 2,
      maxPages: 20,
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const runId = (proposed.value as { runId: string }).runId;

    const list = await execute(registry, adapter, systemCtx, "pending_proposals.list", {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const items = (
      list.value as {
        items: { domain: string; kind: string; proposalId: string; summary: string }[];
      }
    ).items;
    const row = items.find((i) => i.proposalId === runId);
    expect(row).toBeDefined();
    expect(row?.domain).toBe("import");
    expect(row?.kind).toBe("site_import");
    expect(row?.summary).toContain("import-inbox-regression.example.com");
  });
});
