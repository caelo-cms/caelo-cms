// SPDX-License-Identifier: MPL-2.0

/**
 * End-to-end chat turn against a fixture provider:
 *   - User sends "make hero blue"
 *   - Fixture provider returns one edit_module tool call
 *   - Tool dispatch updates the live module via modules.update
 *   - Snapshot lands tagged with the chat's chat_branch_id
 *   - chat_messages has user / assistant / tool rows
 *   - ai_calls row recorded
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

const HUMAN_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const AI_ACTOR = "00000000-0000-0000-0000-000000000a1a";

const humanCtx: ExecutionContext = {
  actorId: HUMAN_ACTOR,
  actorKind: "system",
  requestId: "chat-test-human",
};
const aiCtx: ExecutionContext = {
  actorId: AI_ACTOR,
  actorKind: "ai",
  requestId: "chat-test-ai",
};

const MOD_SLUG = "p5-chat-mod";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM ai_calls WHERE provider = 'anthropic' AND model LIKE 'claude-test%'`;
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-test-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'p5-test-%'`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
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

/**
 * Two-loop fixture: first loop emits a tool_use stop so the runner
 * dispatches edit_module; second loop is the model's follow-up text
 * after seeing the tool result, which ends the turn. Real Anthropic
 * responses always pair tool calls with `stop_reason: "tool_use"`.
 */
function fixtureForOneToolCall(moduleId: string): ProviderEvent[][] {
  return [
    [
      { kind: "text-delta", text: "Updating the hero." },
      {
        kind: "tool-call",
        id: "tu_1",
        name: "edit_module",
        arguments: { moduleId, html: '<h1 style="color:blue">Hero</h1>' },
      },
      { kind: "usage", inputTokens: 100, outputTokens: 30, cachedTokens: 50 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Done — hero is now blue." },
      { kind: "usage", inputTokens: 110, outputTokens: 12, cachedTokens: 100 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ];
}

/**
 * Provider that returns each next call's events from the queue. Lets
 * us replay the multi-turn loop deterministically.
 */
class MultiCallFixtureProvider extends FixtureProvider {
  readonly #queue: ProviderEvent[][];
  #idx = 0;
  constructor(queue: ProviderEvent[][]) {
    super([], "claude-test-1");
    this.#queue = queue;
  }
  override async *generate(): AsyncIterable<ProviderEvent> {
    const events = this.#queue[this.#idx] ?? [
      { kind: "done" as const, stopReason: "end_turn" as const },
    ];
    this.#idx += 1;
    for (const e of events) yield e;
  }
}

describe("chat send → edit_module → snapshot", () => {
  it("dispatches edit_module, lands a branch-tagged snapshot, persists the transcript", async () => {
    // Seed module.
    const create = await execute(registry, adapter, humanCtx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "Hero",
      html: "<h1>Hero</h1>",
      // v0.12.2 — opt out of extractor.
      fields: [{ name: "headline", kind: "text", label: "Headline" } as never],
    });
    if (!create.ok) throw new Error("module seed");
    const moduleId = (create.value as { moduleId: string }).moduleId;

    // Create chat.
    const session = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: "p5-test-edit",
    });
    if (!session.ok) throw new Error("session create");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // Run one turn against the fixture.
    const provider = new MultiCallFixtureProvider(fixtureForOneToolCall(moduleId));
    const tools = createDefaultToolRegistry();
    const events: string[] = [];
    for await (const ev of runChatTurn(
      { adapter, registry, provider, tools, aiCtx, humanCtx },
      { chatSessionId, content: "make hero blue", chips: [] },
    )) {
      events.push(ev.kind);
    }
    expect(events).toContain("text-delta");
    expect(events).toContain("tool-start");
    expect(events).toContain("tool-result");
    expect(events).toContain("done");

    // v0.5.1 — chat-driven module edits stay in the chat's branch
    // (live row unchanged). Verify the latest branched snapshot
    // reflects the edit and live still carries the seed HTML.
    const got = await execute(registry, adapter, humanCtx, "modules.get", { moduleId });
    if (!got.ok) return;
    expect((got.value as { module: { html: string } }).module.html).toBe("<h1>Hero</h1>");

    // Snapshot tagged with the chat branch AND carrying the edit body.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT count(*)::int AS c FROM site_snapshots
          WHERE chat_branch_id = ${chatBranchId}::uuid
        `) as unknown as { c: number }[];
        expect(rows[0]?.c).toBeGreaterThanOrEqual(1);

        const stateRows = (await tx`
          SELECT ms.state FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid AND ss.chat_branch_id = ${chatBranchId}::uuid
          ORDER BY ss.created_at DESC LIMIT 1
        `) as unknown as { state: string | { html: string } }[];
        const raw = stateRows[0]?.state;
        const branchedHtml =
          typeof raw === "string"
            ? (JSON.parse(raw).html as string)
            : ((raw as { html: string }).html ?? "");
        expect(branchedHtml).toContain("color:blue");
      });
    } finally {
      await sql.end();
    }

    // Transcript: user + assistant + tool messages.
    const session2 = await execute(registry, adapter, humanCtx, "chat.get_session", {
      chatSessionId,
    });
    if (!session2.ok) return;
    const messages = (session2.value as { messages: { role: string }[] }).messages;
    const roles = messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");

    // ai_calls recorded.
    const sql2 = new SQL(ADMIN_URL!);
    try {
      await sql2.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT count(*)::int AS c FROM ai_calls WHERE chat_session_id = ${chatSessionId}::uuid
        `) as unknown as { c: number }[];
        expect(rows[0]?.c).toBe(1);
      });
    } finally {
      await sql2.end();
    }
  });
});
