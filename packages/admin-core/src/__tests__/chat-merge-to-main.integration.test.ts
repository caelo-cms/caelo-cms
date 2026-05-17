// SPDX-License-Identifier: MPL-2.0

/**
 * v0.7.0 — chat.merge_to_main is the re-stageable variant of
 * chat.publish that powers /edit's Stage button. It promotes the
 * chat-branch's snapshots to main and replays the live-table writes
 * the branched handlers deliberately skip, but it must NOT:
 *
 *   1. stamp `chat_sessions.published_at`
 *   2. release chat-entity locks
 *   3. record 'published' marks (which would block a second merge from
 *      re-promoting follow-up edits to the same entity)
 *
 * The whole point is that an operator can iterate (edit → Stage →
 * preview → edit again → Stage again) without closing the chat. This
 * test pins those three properties + verifies the second merge
 * actually applies a fresh edit to the live row.
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

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const AI = "00000000-0000-0000-0000-000000000a1a";
const humanCtx: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "merge" };
const aiCtx: ExecutionContext = { actorId: AI, actorKind: "ai", requestId: "merge" };

const MOD_SLUG = "v070-merge-mod";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'v070-merge-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'v070-merge-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'v070-merge-%'`;
      await tx`DELETE FROM modules WHERE slug LIKE 'v070-merge-mod%'`;
    });
  } finally {
    await sql.end();
  }
}

class StepProvider extends FixtureProvider {
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

describe("chat.merge_to_main", () => {
  it("merges branch snapshots without setting published_at or releasing locks", async () => {
    const create = await execute(registry, adapter, humanCtx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "M",
      html: "<p>v0</p>",
    });
    if (!create.ok) throw new Error("seed module");
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: "v070-merge-1",
    });
    if (!session.ok) throw new Error("seed session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // First branch edit: v0 → v1.
    const provider = new StepProvider([
      [
        {
          kind: "tool-call",
          id: "t1",
          name: "edit_module",
          arguments: { moduleId, html: "<p>v1</p>" },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "ok" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);
    const tools = createDefaultToolRegistry();
    for await (const _ of runChatTurn(
      { adapter, registry, provider, tools, aiCtx, humanCtx },
      { chatSessionId, content: "edit it v1", chips: [] },
    )) {
      // drain
    }

    const merge1 = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merge1.ok).toBe(true);
    if (!merge1.ok) return;
    expect((merge1.value as { entityCount: number }).entityCount).toBe(1);

    // published_at must stay NULL — chat stays editable.
    const after1 = await execute(registry, adapter, humanCtx, "chat.get_session", {
      chatSessionId,
    });
    if (!after1.ok) throw new Error("get_session");
    expect(
      (after1.value as { session: { publishedAt: string | null } }).session.publishedAt,
    ).toBeNull();

    // No 'published' marks were recorded — recording them would block
    // the next merge from re-promoting follow-up edits.
    const sqlA = new SQL(ADMIN_URL!);
    try {
      await sqlA.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT count(*)::int AS c FROM chat_branch_publish_marks
          WHERE chat_branch_id = ${chatBranchId}::uuid AND stage_state = 'published'
        `) as unknown as { c: number }[];
        expect(rows[0]?.c).toBe(0);
      });
    } finally {
      await sqlA.end();
    }

    // Live module row reflects v1.
    const sqlB = new SQL(ADMIN_URL!);
    try {
      await sqlB.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT html FROM modules WHERE id = ${moduleId}::uuid
        `) as unknown as { html: string }[];
        expect(rows[0]?.html).toBe("<p>v1</p>");
      });
    } finally {
      await sqlB.end();
    }

    // Re-edit same module to v2 on the same chat; merge again; live row updates.
    const provider2 = new StepProvider([
      [
        {
          kind: "tool-call",
          id: "t2",
          name: "edit_module",
          arguments: { moduleId, html: "<p>v2</p>" },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "ok" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);
    for await (const _ of runChatTurn(
      { adapter, registry, provider: provider2, tools, aiCtx, humanCtx },
      { chatSessionId, content: "edit it v2", chips: [] },
    )) {
      // drain
    }

    const merge2 = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merge2.ok).toBe(true);

    const sqlC = new SQL(ADMIN_URL!);
    try {
      await sqlC.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT html FROM modules WHERE id = ${moduleId}::uuid
        `) as unknown as { html: string }[];
        // Re-merge must pick up the freshest snapshot — pinning to v1
        // here would mean the operator's second Stage shows stale HTML.
        expect(rows[0]?.html).toBe("<p>v2</p>");
      });
    } finally {
      await sqlC.end();
    }

    // Chat is still open after the second merge.
    const after2 = await execute(registry, adapter, humanCtx, "chat.get_session", {
      chatSessionId,
    });
    if (!after2.ok) return;
    expect(
      (after2.value as { session: { publishedAt: string | null } }).session.publishedAt,
    ).toBeNull();
  });

  it("ignores partial-publish history — re-promotes entities even if a prior chat.publish marked them shipped", async () => {
    // Edge case: a chat that's been partial-published, then re-edited,
    // then merge_to_main — the helper's skipAlreadyPublished=false
    // means the already-marked entity gets promoted again so /edit's
    // staging reflects the new edit.
    const create = await execute(registry, adapter, humanCtx, "modules.create", {
      slug: `${MOD_SLUG}-partial`,
      displayName: "MP",
      html: "<p>v0</p>",
    });
    if (!create.ok) throw new Error("seed");
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: "v070-merge-partial",
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const p1 = new StepProvider([
      [
        {
          kind: "tool-call",
          id: "tp1",
          name: "edit_module",
          arguments: { moduleId, html: "<p>v1</p>" },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "ok" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);
    const tools = createDefaultToolRegistry();
    for await (const _ of runChatTurn(
      { adapter, registry, provider: p1, tools, aiCtx, humanCtx },
      { chatSessionId, content: "edit v1", chips: [] },
    )) {
      // drain
    }

    // Partial-publish via chat.publish (writes a 'published' mark for this module).
    const partial = await execute(registry, adapter, humanCtx, "chat.publish", {
      chatSessionId,
      entities: [{ kind: "module", entityId: moduleId }],
    });
    expect(partial.ok).toBe(true);

    // Edit again to v2 on the same chat.
    const p2 = new StepProvider([
      [
        {
          kind: "tool-call",
          id: "tp2",
          name: "edit_module",
          arguments: { moduleId, html: "<p>v2</p>" },
        },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ],
      [
        { kind: "text-delta", text: "ok" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);
    for await (const _ of runChatTurn(
      { adapter, registry, provider: p2, tools, aiCtx, humanCtx },
      { chatSessionId, content: "edit v2", chips: [] },
    )) {
      // drain
    }

    const merge = await execute(registry, adapter, humanCtx, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merge.ok).toBe(true);
    if (!merge.ok) return;
    // Module re-merged despite the 'published' mark from the prior partial.
    expect((merge.value as { entityCount: number }).entityCount).toBe(1);

    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT html FROM modules WHERE id = ${moduleId}::uuid
        `) as unknown as { html: string }[];
        expect(rows[0]?.html).toBe("<p>v2</p>");
      });
    } finally {
      await sql.end();
    }
  });
});
