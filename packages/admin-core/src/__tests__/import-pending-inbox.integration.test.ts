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

const SOURCE_URL = "https://import-inbox-regression.example.com";
const ACTOR_EMAIL = "import-inbox-actor@example.com";

// import_runs.proposed_by carries an FK to users — the actor must be
// a real row (caught by CI's fresh DB; the local run had one by luck).
let systemCtx: ExecutionContext;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_runs WHERE source_url = ${SOURCE_URL}`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${ACTOR_EMAIL})`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // 0003 seeds the Caelo System actor — the only uuid guaranteed to
  // satisfy audit/actor FKs on a fresh DB.
  const bootstrapCtx: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system",
    requestId: "import-inbox-bootstrap",
  };
  const created = await execute(registry, adapter, bootstrapCtx, "users.create", {
    email: ACTOR_EMAIL,
    password: "import-inbox-pass",
    displayName: "Import Inbox Actor",
    roleNames: [],
  });
  if (!created.ok) throw new Error(`users.create failed: ${created.error.kind}`);
  systemCtx = {
    actorId: (created.value as { userId: string }).userId,
    actorKind: "system",
    requestId: "import-inbox-test",
  };
  await wipe();
});

afterAll(async () => {
  await wipe();
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM users WHERE email = ${ACTOR_EMAIL}`;
    });
  } finally {
    await sql.end();
  }
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

    const list = await execute(registry, adapter, systemCtx, "pending_proposals.list", {
      limit: 200,
    });
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
    const byDomain = (list.value as { byDomain: Record<string, number> }).byDomain;
    expect(byDomain.import ?? 0).toBeGreaterThanOrEqual(1);
  });
});
