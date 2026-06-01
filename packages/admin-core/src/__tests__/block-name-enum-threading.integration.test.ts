// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-09 optimization #3) — end-to-end thread test for AC #1.
 *
 * block-name-enum.test.ts (withBlockNameEnum) and describe-schema-block-enum
 * .test.ts (the tool objects' describeSchema) both test the enum in
 * isolation. Neither asserts the ACTUAL chat-runner wiring:
 *
 *   input.activePageId
 *     -> pages.get_with_modules (load the focused page + its template blocks)
 *     -> activePageForState { id, templateId, blockNames }
 *     -> buildToolDescribeState
 *     -> ToolRegistry.catalogue(state)  (invokes describeSchema)
 *     -> GenerateInput.tools handed to the provider
 *
 * That is the seam AC #1 silently regresses through (e.g. an activePage
 * population refactor, or the catalogue not being rebuilt per turn). This
 * captures the exact `tools` array the provider receives for a real focused
 * page and asserts add_module_to_page.blockName / move_module.toBlockName are
 * pinned to that page's template blocks — and that with no focused page they
 * fall back to a free-string (no enum).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import type { AIProvider, GenerateInput, ProviderEvent, ProviderName } from "../ai/provider.js";
import { addModuleToPageTool } from "../ai/tools/add-module-to-page.js";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { moveModuleTool } from "../ai/tools/move-module.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue106-enum-thread",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue106-enum-thread-ai",
};

const PFX = "issue106-enum-thread";
const TPL_SLUG = `${PFX}-tpl`;
const PAGE_SLUG = `${PFX}-page`;

interface CapturedTool {
  name: string;
  inputSchema: { properties?: Record<string, { enum?: string[] }> };
}

/** Captures the `tools` array the chat-runner hands the provider, then ends the turn. */
class CapturingProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model = "claude-test-1";
  capturedTools: CapturedTool[] | null = null;
  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.capturedTools = input.tools as unknown as CapturedTool[];
    yield { kind: "text-delta", text: "noted" };
    yield { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

function enumOf(tools: CapturedTool[] | null, toolName: string, arg: string): string[] | undefined {
  return tools?.find((t) => t.name === toolName)?.inputSchema?.properties?.[arg]?.enum;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let pageId: string;

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, HUMAN, "templates.create", {
    slug: TPL_SLUG,
    displayName: "Enum Thread T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl seed");
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, HUMAN, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const pg = await execute(registry, adapter, HUMAN, "pages.create", {
    slug: PAGE_SLUG,
    title: "Enum Thread P",
    templateId,
  });
  if (!pg.ok) throw new Error("page seed");
  pageId = (pg.value as { pageId: string }).pageId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

function toolsFor(tools: ToolRegistry): ToolRegistry {
  tools.register(addModuleToPageTool);
  tools.register(moveModuleTool);
  return tools;
}

describe("blockName enum threads activePageId -> provider tools (AC #1, #106 opt 3)", () => {
  it("pins add_module_to_page.blockName + move_module.toBlockName to the focused page's blocks", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${PFX}-focused`,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const provider = new CapturingProvider();
    for await (const _ev of runChatTurn(
      { adapter, registry, provider, tools: toolsFor(new ToolRegistry()), aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "add something to this page", chips: [], activePageId: pageId },
    )) {
      // drain
    }

    expect(provider.capturedTools).not.toBeNull();
    // The enum reached the provider's tools payload, scoped to THIS page's
    // template blocks — not a free string the model could fill with "hero".
    expect(enumOf(provider.capturedTools, "add_module_to_page", "blockName")).toEqual(["content"]);
    expect(enumOf(provider.capturedTools, "move_module", "toBlockName")).toEqual(["content"]);
  });

  it("falls back to free-string (no enum) when no page is focused", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${PFX}-nopage`,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId } = session.value as { chatSessionId: string };

    const provider = new CapturingProvider();
    for await (const _ev of runChatTurn(
      { adapter, registry, provider, tools: toolsFor(new ToolRegistry()), aiCtx: AI, humanCtx: HUMAN },
      { chatSessionId, content: "general question", chips: [] },
    )) {
      // drain
    }

    expect(provider.capturedTools).not.toBeNull();
    expect(enumOf(provider.capturedTools, "add_module_to_page", "blockName")).toBeUndefined();
    expect(enumOf(provider.capturedTools, "move_module", "toBlockName")).toBeUndefined();
  });
});
