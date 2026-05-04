// SPDX-License-Identifier: MPL-2.0

/**
 * P10.5 — subagents integration tests.
 *
 *   - chat.list_sessions filters out subagent_role IS NOT NULL rows.
 *   - subagent_runs.create_pending → finish round-trip.
 *   - chat.create_session accepts subagentRole + parentChatSessionId.
 *   - ai_calls.aggregate_for_session sums correctly.
 *   - 4 seed skills are active (qa-check, legal-check, menu-auditor, page-categorizer).
 *
 * NOTE: end-to-end spawn_subagent is exercised at the chat-runner level
 * via FixtureProvider in an existing chat-runner test (covered by the
 * spawn handler's typecheck + this integration suite asserting the
 * dependent ops work).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "subagents-test",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM subagent_runs WHERE role LIKE 'p10_5_test%'`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE '%p10_5_test%' OR subagent_role LIKE 'p10_5_test%'`;
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

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

describe("subagent ops", () => {
  it("chat.create_session accepts subagentRole and parentChatSessionId", async () => {
    const parent = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "p10_5_test parent",
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const parentId = (parent.value as { chatSessionId: string }).chatSessionId;

    const sub = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "[subagent] p10_5_test",
      subagentRole: "p10_5_test_role",
      parentChatSessionId: parentId,
    });
    expect(sub.ok).toBe(true);
  });

  it("chat.list_sessions filters subagent_role IS NOT NULL out of the sidebar", async () => {
    await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "p10_5_test parent visible",
    });
    await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "[subagent] p10_5_test hidden",
      subagentRole: "p10_5_test_role",
    });

    const list = await execute(registry, adapter, systemCtx, "chat.list_sessions", {});
    if (!list.ok) return;
    const titles = (list.value as { sessions: { title: string }[] }).sessions.map((s) => s.title);
    expect(titles).toContain("p10_5_test parent visible");
    expect(titles.some((t) => t.includes("p10_5_test hidden"))).toBe(false);
  });

  it("subagent_runs.create_pending → finish round-trip", async () => {
    const sub = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "[subagent] p10_5_test_round_trip",
      subagentRole: "p10_5_test_round_trip",
    });
    if (!sub.ok) throw new Error("session create failed");
    const subId = (sub.value as { chatSessionId: string }).chatSessionId;

    const create = await execute(registry, adapter, systemCtx, "subagent_runs.create_pending", {
      parentChatSessionId: null,
      parentMessageId: null,
      subagentChatSessionId: subId,
      batchId: null,
      role: "p10_5_test_role",
      task: "test task",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const runId = (create.value as { id: string }).id;

    const finish = await execute(registry, adapter, systemCtx, "subagent_runs.finish", {
      id: runId,
      status: "completed",
      resultJson: { pass: true, issues: [], suggestions: [] },
      costMicrocents: 12345,
      durationMs: 4321,
      errorMessage: null,
    });
    expect(finish.ok).toBe(true);

    const get = await execute(registry, adapter, systemCtx, "subagent_runs.get", { id: runId });
    if (!get.ok) return;
    const row = (
      get.value as {
        run: {
          status: string;
          costMicrocents: number;
          durationMs: number;
          resultJson: { pass: boolean };
        } | null;
      }
    ).run;
    expect(row?.status).toBe("completed");
    expect(row?.costMicrocents).toBe(12345);
    expect(row?.resultJson?.pass).toBe(true);
  });

  it("ai_calls.aggregate_for_session sums correctly", async () => {
    const sess = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "p10_5_test_aggregate",
    });
    if (!sess.ok) throw new Error("session create failed");
    const sessId = (sess.value as { chatSessionId: string }).chatSessionId;

    await execute(registry, adapter, systemCtx, "chat.record_ai_call", {
      chatSessionId: sessId,
      provider: "anthropic",
      model: "fixture",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      costEstimateMicrocents: 1000,
      durationMs: 100,
      succeeded: true,
    });
    await execute(registry, adapter, systemCtx, "chat.record_ai_call", {
      chatSessionId: sessId,
      provider: "anthropic",
      model: "fixture",
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 0,
      costEstimateMicrocents: 2500,
      durationMs: 200,
      succeeded: true,
    });

    const agg = await execute(registry, adapter, systemCtx, "ai_calls.aggregate_for_session", {
      chatSessionId: sessId,
    });
    expect(agg.ok).toBe(true);
    if (!agg.ok) return;
    const v = agg.value as {
      callCount: number;
      costMicrocents: number;
      inputTokens: number;
      outputTokens: number;
    };
    expect(v.callCount).toBe(2);
    expect(v.costMicrocents).toBe(3500);
    expect(v.inputTokens).toBe(300);
    expect(v.outputTokens).toBe(130);
  });

  it("4 seed skills are active (qa-check, legal-check, menu-auditor, page-categorizer)", async () => {
    const list = await execute(registry, adapter, systemCtx, "skills.list", { status: "active" });
    if (!list.ok) return;
    const slugs = (list.value as { skills: { slug: string }[] }).skills.map((s) => s.slug);
    expect(slugs).toContain("qa-check");
    expect(slugs).toContain("legal-check");
    expect(slugs).toContain("menu-auditor");
    expect(slugs).toContain("page-categorizer");
  });

  it("ai_calls accepts parentChatSessionId + parentAiCallId", async () => {
    const parent = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "p10_5_test parent for attribution",
    });
    if (!parent.ok) throw new Error("parent session create failed");
    const parentId = (parent.value as { chatSessionId: string }).chatSessionId;

    const sub = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "[subagent] p10_5_test attribution",
      subagentRole: "p10_5_test_attr",
      parentChatSessionId: parentId,
    });
    if (!sub.ok) throw new Error("sub session create failed");
    const subId = (sub.value as { chatSessionId: string }).chatSessionId;

    const recordR = await execute(registry, adapter, systemCtx, "chat.record_ai_call", {
      chatSessionId: subId,
      provider: "anthropic",
      model: "fixture",
      inputTokens: 50,
      outputTokens: 25,
      cachedTokens: 0,
      costEstimateMicrocents: 500,
      durationMs: 50,
      succeeded: true,
      parentChatSessionId: parentId,
    });
    expect(recordR.ok).toBe(true);

    // Verify the row carries the parent attribution.
    const sql = new SQL(ADMIN_URL);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`
          SELECT parent_chat_session_id::text AS parent_chat_session_id
          FROM ai_calls WHERE chat_session_id = ${subId}::uuid LIMIT 1
        `;
      })) as unknown as { parent_chat_session_id: string }[];
      expect(rows[0]?.parent_chat_session_id).toBe(parentId);
    } finally {
      await sql.end();
    }
  });
});
