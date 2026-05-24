// SPDX-License-Identifier: MPL-2.0

/**
 * P5.2 #3 — tool dispatch is deduped by (chat_session_id, tool_call_id).
 * If the same tool_use id arrives twice in one chat session, the second
 * invocation must return the cached result and NOT mutate the live
 * module a second time.
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

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p5-2-idem",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "p5-2-idem-ai",
};

const SLUG = "p5-2-idem-mod";

class TwoTurnProvider extends FixtureProvider {
  readonly #queue: ProviderEvent[][];
  #idx = 0;
  constructor(q: ProviderEvent[][]) {
    super([], "claude-test-1");
    this.#queue = q;
  }
  override async *generate(): AsyncIterable<ProviderEvent> {
    const events = this.#queue[this.#idx] ?? [
      { kind: "done" as const, stopReason: "end_turn" as const },
    ];
    this.#idx++;
    for (const e of events) yield e;
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-idem-%')`;
      await tx`DELETE FROM chat_tool_results WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-idem-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-2-idem-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'p5-2-idem-%'`;
      await tx`DELETE FROM modules WHERE slug = ${SLUG}`;
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

describe("chat-runner tool-call idempotency", () => {
  it("second tool_use with same id returns the cached result and does not double-mutate", async () => {
    const create = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: SLUG,
      displayName: "M",
      html: "<p>v0</p>",
      // v0.12.2 — opt out of extractor so the assertion on stored html
      // matches the input verbatim.
      fields: [{ name: "body", kind: "text", label: "Body" } as never],
    });
    if (!create.ok) throw new Error("seed");
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "p5-2-idem-1",
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    const sharedToolCallId = "tool_dup_xyz";
    const provider = new TwoTurnProvider([
      [
        {
          kind: "tool-call",
          id: sharedToolCallId,
          name: "edit_module",
          arguments: { moduleId, html: "<p>v1</p>" },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "first ok" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);
    const tools = createDefaultToolRegistry();
    for await (const _ of runChatTurn(
      { adapter, registry, provider, tools, aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "edit", chips: [] },
    )) {
      // drain
    }

    // v0.5.1 — chat-driven module edits stay in the chat's branch
    // (live row is unchanged until publish). Verify the branched
    // snapshot reflects v1 and that live remains v0.
    const sqlCheck = new SQL(ADMIN_URL!);
    const branchHtml = async (): Promise<string> => {
      let html = "";
      await sqlCheck.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT ms.state FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid AND ss.chat_branch_id = ${chatBranchId}::uuid
          ORDER BY ss.created_at DESC LIMIT 1
        `) as unknown as { state: string | { html: string } }[];
        const raw = rows[0]?.state;
        html =
          typeof raw === "string"
            ? (JSON.parse(raw).html as string)
            : ((raw as { html: string }).html ?? "");
      });
      return html;
    };
    expect(await branchHtml()).toBe("<p>v1</p>");
    const liveAfter1 = await execute(registry, adapter, HUMAN, "modules.get", { moduleId });
    if (!liveAfter1.ok) throw new Error("get");
    expect((liveAfter1.value as { module: { html: string } }).module.html).toBe("<p>v0</p>");

    // Turn 2: same tool_call_id, but try to set v2. The runner MUST
    // serve the cached result and NOT mutate the module again.
    const provider2 = new TwoTurnProvider([
      [
        {
          kind: "tool-call",
          id: sharedToolCallId,
          name: "edit_module",
          arguments: { moduleId, html: "<p>v2-SHOULD-NOT-LAND</p>" },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "second ok" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);

    let cachedHits = 0;
    for await (const ev of runChatTurn(
      { adapter, registry, provider: provider2, tools, aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "edit again", chips: [] },
    )) {
      if (ev.kind === "tool-result-cached") cachedHits++;
    }
    expect(cachedHits).toBe(1);

    // Idempotency check: the branched snapshot must still reflect v1,
    // not v2 (cached tool-result short-circuited the second mutation).
    expect(await branchHtml()).toBe("<p>v1</p>");
    const liveAfter2 = await execute(registry, adapter, HUMAN, "modules.get", { moduleId });
    if (!liveAfter2.ok) throw new Error("get2");
    expect((liveAfter2.value as { module: { html: string } }).module.html).toBe("<p>v0</p>");
    await sqlCheck.end();
  });
});
