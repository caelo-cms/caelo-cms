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
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
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
      await tx`DELETE FROM modules WHERE slug = 'p264-test-mod'`;
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

  it("issue #264: a child turn with chatBranchIdOverride writes snapshots to the PARENT's branch", async () => {
    // The migration fan-out depends on this: a write-capable rebuild
    // subagent must land its snapshots on the orchestrator chat's
    // branch (preview/publish/undo scope), NOT on the subagent
    // session's own (unique, otherwise-unused) branch.
    const seed = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: "p264-test-mod",
      displayName: "P264 Hero",
      html: "<h1>Hero</h1>",
      fields: [{ name: "headline", kind: "text", label: "Headline" } as never],
    });
    if (!seed.ok) throw new Error("module seed failed");
    const moduleId = (seed.value as { moduleId: string }).moduleId;

    const parent = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "p10_5_test p264 orchestrator",
    });
    if (!parent.ok) throw new Error("parent session create failed");
    const parentBranchId = (parent.value as { chatBranchId: string }).chatBranchId;
    const parentId = (parent.value as { chatSessionId: string }).chatSessionId;

    const child = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "[subagent] p10_5_test p264 rebuild",
      subagentRole: "p10_5_test_rebuild",
      parentChatSessionId: parentId,
    });
    if (!child.ok) throw new Error("child session create failed");
    const childId = (child.value as { chatSessionId: string }).chatSessionId;
    const childOwnBranchId = (child.value as { chatBranchId: string }).chatBranchId;
    expect(childOwnBranchId).not.toBe(parentBranchId);

    // One-tool-call fixture, same pattern as chat-send-edit-module.
    class QueueProvider extends FixtureProvider {
      #idx = 0;
      readonly #queue: ProviderEvent[][] = [
        [
          { kind: "text-delta", text: "Rebuilding." },
          {
            kind: "tool-call",
            id: "tu_p264",
            name: "edit_module",
            arguments: { moduleId, html: "<h1>Rebuilt hero</h1>" },
          },
          { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
          { kind: "done", stopReason: "tool_use" },
        ],
        [
          { kind: "text-delta", text: '{"pages":[],"summary":"done"}' },
          { kind: "usage", inputTokens: 12, outputTokens: 6, cachedTokens: 0 },
          { kind: "done", stopReason: "end_turn" },
        ],
      ];
      constructor() {
        super([], "claude-test-p264");
      }
      override async *generate(): AsyncIterable<ProviderEvent> {
        const events = this.#queue[this.#idx] ?? [
          { kind: "done" as const, stopReason: "end_turn" as const },
        ];
        this.#idx += 1;
        for (const e of events) yield e;
      }
    }

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "p264-subagent-test",
    };
    for await (const _ev of runChatTurn(
      {
        adapter,
        registry,
        provider: new QueueProvider(),
        tools: createDefaultToolRegistry(),
        aiCtx,
        humanCtx: systemCtx,
        excludedToolNames: new Set(["spawn_subagent", "spawn_subagents"]),
        chatBranchIdOverride: parentBranchId,
      },
      { chatSessionId: childId, content: "REBUILD TASK — rebuild the hero module", chips: [] },
    )) {
      // drain
    }

    const sql = new SQL(ADMIN_URL);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const onParent = (await tx`
          SELECT count(*)::int AS c FROM site_snapshots
          WHERE chat_branch_id = ${parentBranchId}::uuid
        `) as unknown as { c: number }[];
        expect(onParent[0]?.c).toBeGreaterThanOrEqual(1);
        const onChildOwn = (await tx`
          SELECT count(*)::int AS c FROM site_snapshots
          WHERE chat_branch_id = ${childOwnBranchId}::uuid
        `) as unknown as { c: number }[];
        expect(onChildOwn[0]?.c).toBe(0);
      });
    } finally {
      await sql.end();
    }
  });

  it("run #10 D2: spawn_subagent collects the child's result via submit_result", async () => {
    const parent = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "p10_5_test d2 orchestrator",
    });
    if (!parent.ok) throw new Error("parent session create failed");
    const parentId = (parent.value as { chatSessionId: string }).chatSessionId;

    // Provider serves parent + child turns from one queue:
    //   1. parent — spawn_subagent tool call
    //   2. child turn 1 — submit_result tool call (the structured channel)
    //   3. child turn 2 — closing text after the submit ack
    //   4. parent turn 2 — closing text after the spawn result
    class QueueProvider extends FixtureProvider {
      #idx = 0;
      readonly #queue: ProviderEvent[][] = [
        [
          {
            kind: "tool-call",
            id: "tu_d2_spawn",
            name: "spawn_subagent",
            arguments: {
              role: "p10_5_test_d2_rebuilder",
              task: "Rebuild the pricing cluster. Report per-page status.",
              expectedReturnShape: "rebuild",
            },
          },
          { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
          { kind: "done", stopReason: "tool_use" },
        ],
        [
          {
            kind: "tool-call",
            id: "tu_d2_submit",
            name: "submit_result",
            arguments: {
              result: {
                pages: [{ slug: "pricing", status: "rebuilt", notes: "hero + table carried over" }],
                summary: "1 page rebuilt",
              },
            },
          },
          { kind: "usage", inputTokens: 8, outputTokens: 4, cachedTokens: 0 },
          { kind: "done", stopReason: "tool_use" },
        ],
        [
          { kind: "text-delta", text: "Submitted." },
          { kind: "usage", inputTokens: 6, outputTokens: 3, cachedTokens: 0 },
          { kind: "done", stopReason: "end_turn" },
        ],
        [
          { kind: "text-delta", text: "Fan-out complete." },
          { kind: "usage", inputTokens: 6, outputTokens: 3, cachedTokens: 0 },
          { kind: "done", stopReason: "end_turn" },
        ],
      ];
      constructor() {
        super([], "claude-test-d2");
      }
      override async *generate(): AsyncIterable<ProviderEvent> {
        const events = this.#queue[this.#idx] ?? [
          { kind: "done" as const, stopReason: "end_turn" as const },
        ];
        this.#idx += 1;
        for (const e of events) yield e;
      }
    }

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "d2-spawn-submit-test",
    };
    for await (const _ev of runChatTurn(
      {
        adapter,
        registry,
        provider: new QueueProvider(),
        tools: createDefaultToolRegistry(),
        aiCtx,
        humanCtx: systemCtx,
      },
      { chatSessionId: parentId, content: "Rebuild the pricing cluster", chips: [] },
    )) {
      // drain
    }

    // The parent's tool result carries the VALIDATED submitted payload,
    // marked completed — not a free-text parse.
    const sess = await execute(registry, adapter, systemCtx, "chat.get_session", {
      chatSessionId: parentId,
    });
    if (!sess.ok) throw new Error("parent session read failed");
    const messages = (sess.value as { messages: { role: string; content: string }[] }).messages;
    const spawnResult = messages.find(
      (m) => m.role === "tool" && m.content.includes("p10_5_test_d2_rebuilder"),
    );
    expect(spawnResult?.content).toContain("(completed");
    expect(spawnResult?.content).toContain('"status": "rebuilt"');
    expect(spawnResult?.content).toContain("1 page rebuilt");

    // The subagent_runs row landed as completed with the submitted JSON.
    const sql = new SQL(ADMIN_URL);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`
          SELECT status, error_message, result_json
          FROM subagent_runs WHERE role = 'p10_5_test_d2_rebuilder' LIMIT 1
        `;
      })) as unknown as {
        status: string;
        error_message: string | null;
        result_json: { summary?: string } | null;
      }[];
      expect(rows[0]?.status).toBe("completed");
      expect(rows[0]?.error_message).toBeNull();
      expect(rows[0]?.result_json?.summary).toBe("1 page rebuilt");
    } finally {
      await sql.end();
    }
  });

  it("run #10 D2: a child provider error surfaces as a structured child-error, never parseable output", async () => {
    const parent = await execute(registry, adapter, systemCtx, "chat.create_session", {
      title: "p10_5_test d2 child-error orchestrator",
    });
    if (!parent.ok) throw new Error("parent session create failed");
    const parentId = (parent.value as { chatSessionId: string }).chatSessionId;

    const CHILD_ERROR = "provider stream failed: upstream 529 overloaded";
    class QueueProvider extends FixtureProvider {
      #idx = 0;
      readonly #queue: ProviderEvent[][] = [
        [
          {
            kind: "tool-call",
            id: "tu_d2_spawn_err",
            name: "spawn_subagent",
            arguments: {
              role: "p10_5_test_d2_failing",
              task: "Audit the pricing cluster.",
              expectedReturnShape: "verdict",
            },
          },
          { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
          { kind: "done", stopReason: "tool_use" },
        ],
        // Child turn: the provider dies without emitting content — the
        // run #10 class where the child's own error string leaked into
        // the parent as "output" and failed JSON parsing.
        [
          { kind: "error", message: CHILD_ERROR },
          { kind: "done", stopReason: "error" },
        ],
        [
          { kind: "text-delta", text: "Understood, the audit subagent failed." },
          { kind: "usage", inputTokens: 6, outputTokens: 3, cachedTokens: 0 },
          { kind: "done", stopReason: "end_turn" },
        ],
      ];
      constructor() {
        super([], "claude-test-d2-err");
      }
      override async *generate(): AsyncIterable<ProviderEvent> {
        const events = this.#queue[this.#idx] ?? [
          { kind: "done" as const, stopReason: "end_turn" as const },
        ];
        this.#idx += 1;
        for (const e of events) yield e;
      }
    }

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "d2-child-error-test",
    };
    for await (const _ev of runChatTurn(
      {
        adapter,
        registry,
        provider: new QueueProvider(),
        tools: createDefaultToolRegistry(),
        aiCtx,
        humanCtx: systemCtx,
      },
      { chatSessionId: parentId, content: "Audit the pricing cluster", chips: [] },
    )) {
      // drain
    }

    const sess = await execute(registry, adapter, systemCtx, "chat.get_session", {
      chatSessionId: parentId,
    });
    if (!sess.ok) throw new Error("parent session read failed");
    const messages = (sess.value as { messages: { role: string; content: string }[] }).messages;
    const spawnResult = messages.find(
      (m) => m.role === "tool" && m.content.includes("p10_5_test_d2_failing"),
    );
    // Structured failure: kind tag + the child's own error message —
    // and no attempt to parse the error as the child's JSON output.
    expect(spawnResult?.content).toContain("[child-error]");
    expect(spawnResult?.content).toContain(CHILD_ERROR);
    expect(spawnResult?.content).not.toContain("not valid JSON");

    const sql = new SQL(ADMIN_URL);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`
          SELECT status, error_message
          FROM subagent_runs WHERE role = 'p10_5_test_d2_failing' LIMIT 1
        `;
      })) as unknown as { status: string; error_message: string | null }[];
      expect(rows[0]?.status).toBe("errored");
      expect(rows[0]?.error_message).toStartWith("child-error:");
      expect(rows[0]?.error_message).toContain(CHILD_ERROR);
    } finally {
      await sql.end();
    }
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
