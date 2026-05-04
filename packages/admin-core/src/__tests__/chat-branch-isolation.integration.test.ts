// SPDX-License-Identifier: MPL-2.0

/**
 * Two chat sessions edit the same module via fixture providers in
 * parallel. Verifies that:
 *   - Each session's snapshot rows carry its own chat_branch_id
 *   - The latest module_snapshots row per branch reflects that branch's
 *     proposed state (not the other branch's)
 *   - Main (chat_branch_id IS NULL) is untouched until publish
 *
 * Branch-aware reads are an op-by-op rollout; this test pins the
 * write-side guarantee that the runner tags snapshots correctly so
 * branch-aware readers later have the right data to read against.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { MultiFixtureProvider } from "../ai/providers/anthropic.js";
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
  requestId: "p5-iso",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "p5-iso-ai",
};

const MOD_SLUG = "p5-isolation-mod";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-iso-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'p5-iso-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'p5-iso-%'`;
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

function fixture(moduleId: string, html: string): ProviderEvent[][] {
  return [
    [
      {
        kind: "tool-call",
        id: `tu-${html.slice(0, 4)}`,
        name: "edit_module",
        arguments: { moduleId, html },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "ok" },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ];
}

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    // discard
  }
}

describe("chat branch isolation", () => {
  it("two chats produce snapshots tagged with their own branch ids; main untouched", async () => {
    const create = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: MOD_SLUG,
      displayName: "M",
      html: "<p>main</p>",
    });
    if (!create.ok) throw new Error("seed");
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const sessionA = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "p5-iso-a",
    });
    const sessionB = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "p5-iso-b",
    });
    if (!sessionA.ok || !sessionB.ok) throw new Error("session");
    const a = sessionA.value as { chatSessionId: string; chatBranchId: string };
    const b = sessionB.value as { chatSessionId: string; chatBranchId: string };

    const tools = createDefaultToolRegistry();
    await drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider: new MultiFixtureProvider(fixture(moduleId, "<p>edit-from-A</p>")),
          tools,
          aiCtx: AI,
          humanCtx: HUMAN,
        },
        { chatSessionId: a.chatSessionId, content: "edit", chips: [] },
      ),
    );
    await drain(
      runChatTurn(
        {
          adapter,
          registry,
          provider: new MultiFixtureProvider(fixture(moduleId, "<p>edit-from-B</p>")),
          tools,
          aiCtx: AI,
          humanCtx: HUMAN,
        },
        { chatSessionId: b.chatSessionId, content: "edit", chips: [] },
      ),
    );

    // Latest module_snapshots row in branch A reflects A's edit; B's
    // reflects B's edit. Main (no branch) carries the original 'main' from
    // the seed (modules.create wrote a snapshot with chat_branch_id NULL).
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const aRow = (await tx`
          SELECT ms.state FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid AND ss.chat_branch_id = ${a.chatBranchId}::uuid
          ORDER BY ss.created_at DESC LIMIT 1
        `) as unknown as { state: string | { html: string } }[];
        const aHtml =
          typeof aRow[0]?.state === "string"
            ? (JSON.parse(aRow[0].state).html as string)
            : (aRow[0]?.state as { html: string }).html;
        expect(aHtml).toContain("edit-from-A");

        const bRow = (await tx`
          SELECT ms.state FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid AND ss.chat_branch_id = ${b.chatBranchId}::uuid
          ORDER BY ss.created_at DESC LIMIT 1
        `) as unknown as { state: string | { html: string } }[];
        const bHtml =
          typeof bRow[0]?.state === "string"
            ? (JSON.parse(bRow[0].state).html as string)
            : (bRow[0]?.state as { html: string }).html;
        expect(bHtml).toContain("edit-from-B");

        // Main snapshot for this module — still the seeded "main" body.
        const mainRow = (await tx`
          SELECT ms.state FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid AND ss.chat_branch_id IS NULL
          ORDER BY ss.created_at DESC LIMIT 1
        `) as unknown as { state: string | { html: string } }[];
        const mainHtml =
          typeof mainRow[0]?.state === "string"
            ? (JSON.parse(mainRow[0].state).html as string)
            : (mainRow[0]?.state as { html: string }).html;
        expect(mainHtml).toBe("<p>main</p>");
      });
    } finally {
      await sql.end();
    }
  });
});
