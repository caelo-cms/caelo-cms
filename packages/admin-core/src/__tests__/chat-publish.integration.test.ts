// SPDX-License-Identifier: MPL-2.0

/**
 * chat.publish merges every chat-branch snapshot into a single main
 * snapshot (no chat_branch_id) and stamps the session published_at.
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

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const AI = "00000000-0000-0000-0000-000000000a1a";
const humanCtx: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "p" };
const aiCtx: ExecutionContext = { actorId: AI, actorKind: "ai", requestId: "p" };

const MOD_SLUG = "p5-publish-mod";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-pub-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-pub-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'p5-pub-%'`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

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

describe("chat.publish", () => {
  it("merges branch snapshots into main and stamps published_at", async () => {
    const create = await execute(registry, adapter, humanCtx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "M",
      html: "<p>v0</p>",
    });
    if (!create.ok) throw new Error("seed");
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: "p5-pub-1",
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    const provider = new TwoTurnProvider([
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
      { chatSessionId, content: "edit it", chips: [] },
    )) {
      // drain
    }

    // Branch snapshot count > 0 before publish.
    const sql = new SQL(ADMIN_URL!);
    let branchCount = 0;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT count(*)::int AS c FROM site_snapshots WHERE chat_branch_id = ${chatBranchId}::uuid
        `) as unknown as { c: number }[];
        branchCount = rows[0]?.c ?? 0;
      });
    } finally {
      await sql.end();
    }
    expect(branchCount).toBeGreaterThan(0);

    // Publish.
    const pub = await execute(registry, adapter, humanCtx, "chat.publish", { chatSessionId });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    expect((pub.value as { entityCount: number }).entityCount).toBe(1);

    // A new main snapshot exists with op_kind=chat.publish.
    const sql2 = new SQL(ADMIN_URL!);
    try {
      await sql2.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT op_kind, chat_branch_id::text AS chat_branch_id
          FROM site_snapshots WHERE id = ${(pub.value as { siteSnapshotId: string }).siteSnapshotId}::uuid
        `) as unknown as { op_kind: string; chat_branch_id: string | null }[];
        expect(rows[0]?.op_kind).toBe("chat.publish");
        // Merged snapshot is on main, not the branch.
        expect(rows[0]?.chat_branch_id).toBeNull();
      });
    } finally {
      await sql2.end();
    }

    // Session published_at set.
    const session2 = await execute(registry, adapter, humanCtx, "chat.get_session", {
      chatSessionId,
    });
    if (!session2.ok) return;
    expect(
      (session2.value as { session: { publishedAt: string | null } }).session.publishedAt,
    ).not.toBeNull();
  });

  it("publishing twice fails the second call", async () => {
    const session = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: "p5-pub-empty",
    });
    if (!session.ok) return;
    const { chatSessionId } = session.value as { chatSessionId: string };

    // First publish on an empty branch is a no-op-success.
    const r1 = await execute(registry, adapter, humanCtx, "chat.publish", { chatSessionId });
    expect(r1.ok).toBe(true);

    const r2 = await execute(registry, adapter, humanCtx, "chat.publish", { chatSessionId });
    expect(r2.ok).toBe(false);
  });
});
