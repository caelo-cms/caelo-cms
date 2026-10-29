// SPDX-License-Identifier: MPL-2.0

/**
 * The tool list a chat sends is the same on every turn, whatever skills the
 * chat loaded.
 *
 * The tool list is the very front of the provider's prompt prefix (tools ->
 * system -> messages). Until 2026-10 a skill loaded with `load_skill` tagged
 * its allowlisted tools `alwaysLoaded` from the NEXT turn on, so that turn's
 * tool list differed and the provider re-wrote the whole chat history to its
 * cache at full price: in the e2e-livedit runs of 2026-10-26 every such turn
 * started with a cache miss of 100–170k tokens (14–19 % of a run's cost).
 * Driven end-to-end through runChatTurn: a chat with a `load_skill` call in
 * its history must hand the provider exactly the tool definitions a fresh
 * chat gets.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import type { AIProvider, GenerateInput, ProviderEvent, ProviderName } from "../ai/provider.js";
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
  requestId: "stable-tools",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "stable-tools-ai",
};

const SLUG = "stable-tools-skill";

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  alwaysLoaded?: boolean;
}
/** Captures the `tools` array the chat-runner hands the provider, then ends the turn. */
class CapturingProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  capturedTools: CapturedTool[] | null = null;
  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.capturedTools = input.tools as unknown as CapturedTool[];
    yield { kind: "text-delta", text: "ok" };
    yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

async function seedSkill(slug: string, allowlist: string[]): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
        VALUES (${slug}, ${slug}, 'test', 'test body',
                (${JSON.stringify(allowlist)}::text)::jsonb,
                (${JSON.stringify({ chipTrigger: false, alwaysOn: false })}::text)::jsonb,
                'active')
        ON CONFLICT (slug) DO UPDATE SET
          allowlisted_tools = EXCLUDED.allowlisted_tools,
          auto_engagement_hints = EXCLUDED.auto_engagement_hints,
          status = 'active'
      `;
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'stable-tools-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'stable-tools-%'`;
      await tx`DELETE FROM skills WHERE slug = ${SLUG}`;
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
 * Runs one turn on a fresh chat and returns the tool definitions the
 * provider received. With `loadedSkill` the chat's history first carries a
 * `load_skill` call for it and its result, as after an earlier turn.
 */
async function captureToolsForTurn(loadedSkill: string | null): Promise<CapturedTool[]> {
  const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
    title: `stable-tools-${loadedSkill ?? "fresh"}`,
  });
  if (!session.ok) throw new Error("session");
  const { chatSessionId } = session.value as { chatSessionId: string };
  if (loadedSkill) {
    await execute(registry, adapter, HUMAN, "chat.append_message", {
      chatSessionId,
      role: "assistant",
      content: "loading skill",
      toolCalls: [{ id: "seed-load", name: "load_skill", arguments: { slugs: [loadedSkill] } }],
    });
    await execute(registry, adapter, HUMAN, "chat.append_message", {
      chatSessionId,
      role: "tool",
      content: "loaded",
      toolCallId: "seed-load",
    });
  }
  const provider = new CapturingProvider();
  for await (const _ev of runChatTurn(
    {
      adapter,
      registry,
      provider,
      tools: createDefaultToolRegistry(),
      aiCtx: AI,
      humanCtx: HUMAN,
    },
    { chatSessionId, content: "please continue", chips: [] },
  )) {
    // drain
  }
  if (!provider.capturedTools) throw new Error("no tools captured");
  return provider.capturedTools;
}

/** The provider-facing part of a definition (execute closures differ per turn by design). */
function wireShape(tools: CapturedTool[]): unknown {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    alwaysLoaded: t.alwaysLoaded === true,
  }));
}

describe("tool list across turns", () => {
  it("a loaded skill leaves the next turn's tool list byte-identical", async () => {
    // A long-tail write (not in the core set): under the old preload it
    // turned `alwaysLoaded` on the turn after the skill was loaded.
    await seedSkill(SLUG, ["set_page_seo_many", "bulk_create_redirects"]);
    const fresh = await captureToolsForTurn(null);
    const afterLoad = await captureToolsForTurn(SLUG);
    expect(JSON.stringify(wireShape(afterLoad))).toBe(JSON.stringify(wireShape(fresh)));
    const byName = new Map(afterLoad.map((t) => [t.name, t]));
    // The skill's tools stay reachable through tool search, deferred.
    expect(byName.has("set_page_seo_many")).toBe(true);
    expect(byName.get("set_page_seo_many")?.alwaysLoaded).toBeFalsy();
    // The core set ships in full either way.
    expect(byName.get("build_page")?.alwaysLoaded).toBe(true);
  });
});
