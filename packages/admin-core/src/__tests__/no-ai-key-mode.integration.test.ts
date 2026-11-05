// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1460 — the install runs without an AI key, by the Owner's choice.
 * Against real Postgres: the stored state and how it starts and ends, the
 * MCP surfaces, and every caller of the install's own AI from the issue's
 * inventory. Each one has a defined result here; none reaches for the
 * environment's key, none answers "AI provider not configured".
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, NO_INSTALL_AI_PREFIX } from "@caelo-cms/shared";
import { SQL } from "bun";
import { judgeTurnCompleteness } from "../ai/chat-runner/turn-completeness-judge.js";
import { makePluginImageProvider } from "../ai/plugin-image-provider.js";
import { makePluginTextProvider } from "../ai/plugin-text-provider.js";
import {
  configureProviderResolver,
  getActiveProvider,
  getActiveProviderForModel,
  getActiveProviderForPurpose,
  getImageProviderApiKey,
  invalidateProviderCache,
  isMcpOnlyInstall,
} from "../ai/provider-resolver.js";
import { putPageInspection } from "../ai/tools/_page-inspection-cache.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { queryPageHtmlTool } from "../ai/tools/query-page-html.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const FAKE_KEK = "ab".repeat(32);
const previousKek = process.env.CAELO_SECRET_KEK;
const previousAnthropic = process.env.ANTHROPIC_API_KEY;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "no-ai-key-test",
};
const ownerCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000002",
  actorKind: "human",
  requestId: "no-ai-key-test-owner",
};
const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "no-ai-key-test-ai",
};

async function asSystem(fn: (tx: Bun.SQL) => Promise<unknown>): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function reset(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM mcp_only_mode`;
    await tx`DELETE FROM ai_providers`;
  });
  invalidateProviderCache();
}

async function mode(): Promise<string> {
  const r = await execute(registry, adapter, ownerCtx, "ai_providers.get_mode", {});
  if (!r.ok) throw new Error(`get_mode: ${JSON.stringify(r.error)}`);
  return (r.value as { mode: string }).mode;
}

async function chooseMcpOnly(): Promise<void> {
  const r = await execute(registry, adapter, ownerCtx, "ai_providers.set_mcp_only", {});
  if (!r.ok) throw new Error(`set_mcp_only: ${JSON.stringify(r.error)}`);
}

async function storeKey(apiKey?: string): Promise<void> {
  const r = await execute(registry, adapter, ownerCtx, "ai_providers.set", {
    name: "anthropic",
    displayName: "Anthropic",
    config: { model: "claude-sonnet-4-6" },
    isActive: true,
    ...(apiKey ? { apiKey } : {}),
  });
  if (!r.ok) throw new Error(`ai_providers.set: ${JSON.stringify(r.error)}`);
}

async function mintAdminToken(allowCaeloAi: boolean): Promise<string> {
  const r = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
    displayName: `no-ai-key-${allowCaeloAi}-${crypto.randomUUID()}`,
    scope: "admin",
    allowCaeloAi,
  });
  if (!r.ok) throw new Error(`mint: ${JSON.stringify(r.error)}`);
  return (r.value as { plaintextToken: string }).plaintextToken;
}

function message(r: { ok: false; error: { kind: string } }): string {
  return "message" in r.error ? String(r.error.message) : r.error.kind;
}

beforeAll(async () => {
  process.env.CAELO_SECRET_KEK = FAKE_KEK;
  delete process.env.ANTHROPIC_API_KEY;
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL as string,
    publicDatabaseUrl: PUBLIC_URL as string,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  configureProviderResolver({ adapter, registry });
  configureMcpBridge({
    adapter,
    registry,
    resolveProvider: async () => (await getActiveProvider())?.provider ?? null,
  });
  await asSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${ownerCtx.actorId}::uuid, 'human', 'no-ai-key owner')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${ownerCtx.actorId}::uuid, 'no-ai-key-owner@example.test', 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${ownerCtx.actorId}::uuid, id FROM roles WHERE name = 'owner'
             ON CONFLICT DO NOTHING`;
  });
  await reset();
});

afterEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await reset();
});

afterAll(() => {
  if (previousKek === undefined) delete process.env.CAELO_SECRET_KEK;
  else process.env.CAELO_SECRET_KEK = previousKek;
  if (previousAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = previousAnthropic;
});

describe("the stored choice", () => {
  it("is unset until the Owner decides, and an absent key alone never reads as the mode", async () => {
    expect(await mode()).toBe("unset");
    await storeKey();
    // A provider row without a key is not a decision either.
    expect(await mode()).toBe("unset");
  });

  it("writes no provider row and is audited", async () => {
    await chooseMcpOnly();
    expect(await mode()).toBe("mcp_only");
    const list = await execute(registry, adapter, ownerCtx, "ai_providers.list", {});
    expect(list.ok && (list.value as { providers: unknown[] }).providers).toEqual([]);
    const sql = new SQL(ADMIN_URL as string);
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx`SELECT 1 FROM audit_events WHERE operation = 'ai_providers.set_mcp_only'
                  AND request_id = ${ownerCtx.requestId} LIMIT 1`;
      });
      expect(rows.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("is the Owner's: the AI cannot set it", async () => {
    const r = await execute(registry, adapter, aiCtx, "ai_providers.set_mcp_only", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
    expect(await mode()).toBe("unset");
  });

  it("is refused while a usable key exists, and the refusal names the way out", async () => {
    await storeKey("sk-ant-test");
    const r = await execute(registry, adapter, ownerCtx, "ai_providers.set_mcp_only", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(message(r)).toContain("/settings/ai");
    expect(await mode()).toBe("provider");
  });

  it("counts the legacy env key as a provider, like the resolver does", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    expect(await mode()).toBe("provider");
  });

  it("ends when a key is stored, with no further step, and the provider resolves at once", async () => {
    await chooseMcpOnly();
    expect(await getActiveProvider()).toBeNull();
    await storeKey("sk-ant-test");
    expect(await mode()).toBe("provider");
    expect(await isMcpOnlyInstall()).toBe(false);
    expect((await getActiveProvider())?.providerName).toBe("anthropic");
  });

  it("survives a save without a key", async () => {
    await chooseMcpOnly();
    await storeKey();
    expect(await mode()).toBe("mcp_only");
  });

  it("does not switch on when the last key is removed", async () => {
    await storeKey("sk-ant-test");
    const r = await execute(registry, adapter, ownerCtx, "ai_providers.clear_key", {
      name: "anthropic",
    });
    expect(r.ok).toBe(true);
    expect(await mode()).toBe("unset");
  });
});

describe("the provider callers in this mode", () => {
  it("resolver: nothing resolves, the environment's key included", async () => {
    await chooseMcpOnly();
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    process.env.GOOGLE_API_KEY = "google-env";
    try {
      expect(await getActiveProvider()).toBeNull();
      expect(await getActiveProviderForModel("claude-sonnet-4-6")).toBeNull();
      expect(await getActiveProviderForPurpose("translation")).toBeNull();
      expect(await getImageProviderApiKey("google")).toBeNull();
    } finally {
      delete process.env.GOOGLE_API_KEY;
    }
  });

  it("plugin ctx.ai: complete and generateObject refuse with the mode's error", async () => {
    await chooseMcpOnly();
    const provider = makePluginTextProvider();
    const opts = { system: "s", messages: [{ role: "user" as const, content: "u" }] };
    for (const call of [
      () => provider.complete({ ...opts, maxTokens: 10 }),
      () => provider.generateObject({ ...opts, jsonSchema: { type: "object" } }),
    ]) {
      const e = await call().then(
        () => null,
        (x: Error) => x,
      );
      expect(e?.message).toStartWith(NO_INSTALL_AI_PREFIX);
      expect(e?.message).toContain("/settings/mcp");
    }
  });

  it("plugin ctx.images: describe refuses with the mode's error", async () => {
    await chooseMcpOnly();
    const e = await makePluginImageProvider({ adapter, registry })
      .describe()
      .then(
        () => null,
        (x: Error) => x,
      );
    expect(e?.message).toStartWith(NO_INSTALL_AI_PREFIX);
  });

  it("without the mode the plugin path keeps naming the mistake", async () => {
    const e = await makePluginTextProvider()
      .complete({ system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 10 })
      .then(
        () => null,
        (x: Error) => x,
      );
    expect(e?.message).toContain("AI provider not configured");
  });

  it("query_page_html describe: hands the HTML to the agent, and refuses with a way out otherwise", async () => {
    await chooseMcpOnly();
    const pageRef = putPageInspection("no-ai-key", {
      url: "https://example.test/",
      html: "<main>the price is 12</main>",
      markdown: "the price is 12",
    });
    const input = { pageRef, describe: "the price" };
    const toolCtx = { adapter, registry } as unknown as ToolContext;
    const delegated = await queryPageHtmlTool.handler(aiCtx, input, {
      ...toolCtx,
      aiDelegated: true,
    });
    expect(delegated.ok).toBe(true);
    expect(delegated.content).toContain("the price is 12");
    const undelegated = await queryPageHtmlTool.handler(aiCtx, input, toolCtx);
    expect(undelegated.ok).toBe(false);
    expect(undelegated.content).toContain("Use `keyword`");
    expect(undelegated.content).not.toContain("AI provider not configured");
  });

  it("turn-completeness judge: declines, never forces a tool call", async () => {
    await chooseMcpOnly();
    const verdict = await judgeTurnCompleteness({
      userRequest: "make it blue",
      assistantText: "done",
      toolNames: [],
    });
    expect(verdict).toBeNull();
  });
});

describe("MCP in this mode", () => {
  it("an admin token works; its stored 'may use Caelo's AI' cannot reach an AI that is not there", async () => {
    const token = await mintAdminToken(true);
    await chooseMcpOnly();
    const opened = await execute(registry, adapter, systemCtx, "mcp.open_session", {
      plaintextToken: token,
      title: "no-ai-key work",
    });
    if (!opened.ok) throw new Error(`open: ${JSON.stringify(opened.error)}`);
    const { chatSessionId } = opened.value as { chatSessionId: string };
    const run = async (toolName: string, args: Record<string, unknown>) => {
      const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
        plaintextToken: token,
        chatSessionId,
        toolName,
        args,
      });
      if (!r.ok) throw new Error(`${toolName}: ${JSON.stringify(r.error)}`);
      return r.value as { ok: boolean; content: string };
    };

    const pages = await run("list_pages", {});
    expect(pages.ok).toBe(true);
    const image = await run("generate_image", {
      prompt: "a red square",

      altText: "red",
    });
    expect(image.ok).toBe(false);
    expect(image.content).toContain("AiDelegated:");
    expect(image.content).toContain("caelo_upload_images");
    expect(image.content).not.toContain("AI provider not configured");
  });

  it("the catalogue and the context tell the agent the mode", async () => {
    const token = await mintAdminToken(false);
    await chooseMcpOnly();
    const tools = await execute(registry, adapter, systemCtx, "mcp.list_tools", {
      plaintextToken: token,
    });
    if (!tools.ok) throw new Error("list_tools");
    const generate = (tools.value as { tools: { name: string; description: string }[] }).tools.find(
      (t) => t.name === "generate_image",
    );
    expect(generate?.description).toContain("the install's AI is not used");
    const context = await execute(registry, adapter, systemCtx, "mcp.get_context", {
      plaintextToken: token,
    });
    if (!context.ok) throw new Error("get_context");
    const { systemContext, statusLine } = context.value as {
      systemContext: string;
      statusLine: string | null;
    };
    expect(systemContext).toContain("This install runs without an AI key");
    expect(systemContext).toContain("Do not offer generate_image");
    expect(statusLine).toContain("[Site status — install AI]");
  });

  it("caelo_chat refuses with the mode's error, not the generic one", async () => {
    const created = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
      displayName: `no-ai-key-chat-${crypto.randomUUID()}`,
      scope: "chat",
    });
    if (!created.ok) throw new Error("mint chat");
    await chooseMcpOnly();
    const r = await execute(registry, adapter, systemCtx, "mcp.send_chat", {
      plaintextToken: (created.value as { plaintextToken: string }).plaintextToken,
      message: "hello",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(message(r)).toStartWith(NO_INSTALL_AI_PREFIX);
    expect(message(r)).not.toContain("AI provider not configured");
  });

  it("a chat token cannot be minted or proposed; an admin token can", async () => {
    await chooseMcpOnly();
    const direct = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
      displayName: "no-ai-key-refused",
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(message(direct)).toContain("scope 'admin'");
    const proposed = await execute(registry, adapter, ownerCtx, "mcp_tokens.propose_create", {
      displayName: "no-ai-key-refused",
      scope: "chat",
    });
    expect(proposed.ok).toBe(false);
    if (!proposed.ok) expect(message(proposed)).toContain("scope 'admin'");
    const admin = await execute(registry, adapter, ownerCtx, "mcp_tokens.propose_create", {
      displayName: "no-ai-key-admin",
      scope: "admin",
    });
    expect(admin.ok).toBe(true);
    await mintAdminToken(false);
  });
});
