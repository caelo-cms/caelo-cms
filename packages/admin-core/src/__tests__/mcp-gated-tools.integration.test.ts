// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #687 — every approval-gated tool works over the Power-MCP.
 *
 * An approval-declared PLUGIN tool (`set_locales`) used to be refused on
 * this surface ("ask the operator to run this in the Caelo chat"), because
 * its only gate was the SDK's in-chat pause. It now queues an approval card
 * for the operator, tagged as the external agent's (#658), and Approve runs
 * it through the plugin host; the decision reaches the agent through
 * mcp.get_approval_outcome and never as a message in the shared chat.
 * Core `needsApproval` tools (`delete_pages_many` with 5+ pages) take the
 * same queue. The catalogue test pins that no gated tool silently drops off
 * the MCP surface.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  pluginToolsRegistry,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { approveQueuedToolCall } from "../ai/queued-tool-approval.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { POWER_MCP_EXCLUDED_TOOLS, powerToolCatalogue } from "../ops/security/mcp_power.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const systemCtx: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "mcp-gated-test",
};
/** The token's owner — the human the external agent works for. */
const ownerCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000002",
  actorKind: "human",
  requestId: "mcp-gated-test-owner",
};
/**
 * The operator who clicks Approve/Reject — holds the Owner role. A real
 * (RFC 4122) uuid: the plugin host's permission check validates it.
 */
const approverCtx: ExecutionContext = {
  actorId: crypto.randomUUID(),
  actorKind: "human",
  requestId: "mcp-gated-test-approver",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let adminToken: string;
let chatSessionId: string;
let chatBranchId: string;

async function withSystemTx<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

/** The live locale registry, read the way the plugin's own tools read it. */
async function localeCodes(): Promise<string[]> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
    pluginSlug: "international-site",
    operationName: "intl_status",
    args: {},
  });
  if (!r.ok) throw new Error(`intl_status: ${r.error.message}`);
  return (r.value as { locales: Array<{ code: string }> }).locales.map((l) => l.code).sort();
}

async function messageCount(): Promise<number> {
  return withSystemTx(async (tx) => {
    const rows = await tx`SELECT count(*)::int AS c FROM chat_messages
                          WHERE chat_session_id = ${chatSessionId}::uuid`;
    return (rows[0] as { c: number }).c;
  });
}

interface ExecuteToolValue {
  ok: boolean;
  content: string;
  approval?: { proposalId: string; domain: string } | null;
}

async function callOverMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ExecuteToolValue> {
  const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
    plaintextToken: adminToken,
    chatSessionId,
    toolName,
    args,
  });
  if (!r.ok) throw new Error(`execute_tool failed: ${JSON.stringify(r.error)}`);
  return r.value as ExecuteToolValue;
}

async function outcome(proposalId: string) {
  const r = await execute(registry, adapter, systemCtx, "mcp.get_approval_outcome", {
    plaintextToken: adminToken,
    proposalId,
  });
  if (!r.ok) throw new Error(`get_approval_outcome failed: ${JSON.stringify(r.error)}`);
  return r.value as { outcome: string; detail: string | null; toolName: string };
}

const EN_DE = [
  { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
  { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
];

async function cleanup(): Promise<void> {
  resetPluginHost();
  await withSystemTx(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't687-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't687-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't687-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  await withSystemTx(async (tx) => {
    for (const [id, name] of [
      [ownerCtx.actorId, "mcp-gated owner"],
      [approverCtx.actorId, "mcp-gated approver"],
    ] as const) {
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${id}::uuid, 'human', ${name}) ON CONFLICT (id) DO NOTHING`;
    }
    // The token's owner: a token only resolves for a live user holding a role.
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${ownerCtx.actorId}::uuid, 'owner@mcp-gated.test', 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${ownerCtx.actorId}::uuid, id FROM roles WHERE name = 'editor'
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${approverCtx.actorId}::uuid, ${`approver-${approverCtx.actorId.slice(0, 8)}@mcp-gated.test`}, 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${approverCtx.actorId}::uuid, id FROM roles WHERE name = 'owner'
             ON CONFLICT DO NOTHING`;
  });
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
  const minted = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
    displayName: `gated-test-${crypto.randomUUID().slice(0, 8)}`,
    scope: "admin",
  });
  if (!minted.ok) throw new Error(`token mint failed: ${JSON.stringify(minted.error)}`);
  adminToken = (minted.value as { plaintextToken: string }).plaintextToken;
  const opened = await execute(registry, adapter, systemCtx, "mcp.open_session", {
    plaintextToken: adminToken,
    title: "mcp-gated-test session",
  });
  if (!opened.ok) throw new Error(`open_session failed: ${JSON.stringify(opened.error)}`);
  ({ chatSessionId, chatBranchId } = opened.value as {
    chatSessionId: string;
    chatBranchId: string;
  });
});

afterAll(async () => {
  await withSystemTx(async (tx) => {
    await tx`DELETE FROM mcp_approval_handoffs WHERE chat_session_id = ${chatSessionId}::uuid`;
    await tx`DELETE FROM tool_approval_actions WHERE chat_session_id = ${chatSessionId}::uuid`;
    await tx`DELETE FROM mcp_tokens WHERE actor_id = ${ownerCtx.actorId}::uuid`;
  });
  await cleanup();
  await adapter.close();
});

describe("#687 — approval-declared plugin tools over the Power-MCP", () => {
  it("set_locales queues a card for the session, Approve sets the locales, the MCP gets 'applied'", async () => {
    const before = await localeCodes();
    const messagesBefore = await messageCount();

    const r = await callOverMcp("set_locales", { locales: EN_DE });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/^Queued proposal [0-9a-f-]{36}: set_locales/);
    expect(r.content).not.toContain("Caelo chat");
    expect(r.approval?.domain).toBe("tool_approvals");
    const proposalId = r.approval?.proposalId ?? "";
    // Nothing applied before the click.
    expect(await localeCodes()).toEqual(before);
    // The proposing branch is fixed at queue time (0262) — a later session
    // move cannot retarget the approved call.
    const queuedBranch = await withSystemTx(async (tx) => {
      const rows = await tx`SELECT chat_branch_id::text AS b FROM tool_approval_actions
                            WHERE id = ${proposalId}::uuid`;
      return (rows[0] as { b: string | null } | undefined)?.b ?? null;
    });
    expect(queuedBranch).toBe(chatBranchId);

    // The card the Live Edit strip renders for this session.
    const listed = await execute(registry, adapter, ownerCtx, "pending_proposals.list", {
      limit: 200,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const card = (
      listed.value as {
        items: Array<{
          proposalId: string;
          domain: string;
          summary: string;
          chatSessionId: string | null;
          requestedVia: string | null;
        }>;
      }
    ).items.find((i) => i.proposalId === proposalId);
    expect(card).toMatchObject({
      domain: "tool_approvals",
      chatSessionId,
      requestedVia: "power_mcp",
    });
    expect(card?.summary).toContain("set_locales");
    expect((await outcome(proposalId)).outcome).toBe("pending");

    // The operator's Approve (what the strip's button posts to).
    const approved = await approveQueuedToolCall({
      registry,
      adapter,
      approverCtx,
      proposalId,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value).toMatchObject({ ok: true, toolName: "set_locales" });
    expect(await localeCodes()).toEqual(["de", "en"]);

    const decided = await outcome(proposalId);
    expect(decided.outcome).toBe("applied");
    expect(decided.toolName).toBe("set_locales");
    expect(decided.detail).toContain("locales");

    // A second click applies nothing twice.
    const again = await approveQueuedToolCall({ registry, adapter, approverCtx, proposalId });
    expect(again.ok).toBe(false);

    // No Live Edit AI turn: the shared session got no message.
    expect(await messageCount()).toBe(messagesBefore);
  });

  it("reject: nothing is written and the MCP gets 'rejected' with the reason", async () => {
    const before = await localeCodes();
    const r = await callOverMcp("set_locales", {
      locales: [{ code: "fr", displayName: "Français", urlStrategy: "none", isDefault: true }],
    });
    const proposalId = r.approval?.proposalId ?? "";
    expect(proposalId).not.toBe("");
    const rejected = await execute(
      registry,
      adapter,
      approverCtx,
      "tool_approvals.reject_proposal",
      { proposalId, reason: "keep English and German" },
    );
    expect(rejected.ok).toBe(true);
    expect(await outcome(proposalId)).toMatchObject({
      outcome: "rejected",
      detail: "keep English and German",
    });
    expect(await localeCodes()).toEqual(before);
  });

  it("an approver without the tool's permission is refused and the card stays pending", async () => {
    const editorCtx: ExecutionContext = {
      actorId: crypto.randomUUID(),
      actorKind: "human",
      requestId: "mcp-gated-test-editor",
    };
    await withSystemTx(async (tx) => {
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${editorCtx.actorId}::uuid, 'human', 'mcp-gated editor')`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${editorCtx.actorId}::uuid, ${`editor-${editorCtx.actorId.slice(0, 8)}@mcp-gated.test`}, 'test-only')`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${editorCtx.actorId}::uuid, id FROM roles WHERE name = 'editor'`;
    });
    const r = await callOverMcp("set_locales", { locales: EN_DE });
    const proposalId = r.approval?.proposalId ?? "";
    const refused = await approveQueuedToolCall({
      registry,
      adapter,
      approverCtx: editorCtx,
      proposalId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("settings.write");
    // Not consumed: the Owner can still approve it.
    expect((await outcome(proposalId)).outcome).toBe("pending");
    const approved = await approveQueuedToolCall({ registry, adapter, approverCtx, proposalId });
    expect(approved.ok).toBe(true);
    expect((await outcome(proposalId)).outcome).toBe("applied");
  });

  it("arguments that cannot apply are refused before any card is shown", async () => {
    const r = await callOverMcp("set_locales", { locales: [{ code: "en" }] });
    expect(r.ok).toBe(false);
    expect(r.approval ?? null).toBeNull();
    expect(r.content).toContain("InvalidToolInput");
    expect(r.content).toContain("no approval was requested");
  });
});

describe("#687 — a core needsApproval tool over the Power-MCP", () => {
  it("delete_pages_many with 5 pages queues, Approve deletes, the MCP gets 'applied'", async () => {
    const templateId = await withSystemTx(async (tx) => {
      const lay = (await tx.unsafe(
        "INSERT INTO layouts (slug, display_name, html, css) VALUES ('t687-lay', 'L', '<html></html>', '') RETURNING id::text AS id",
      )) as { id: string }[];
      const tpl = (await tx.unsafe(
        `INSERT INTO templates (slug, display_name, html, css, layout_id) VALUES ('t687-tpl', 'T', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
      )) as { id: string }[];
      await adoptTemplateIntoHomePageType(tx, tpl[0]?.id ?? "");
      return tpl[0]?.id ?? "";
    });
    const pageIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = await execute(registry, adapter, systemCtx, "pages.create", {
        slug: `t687-page-${i}`,
        title: `t687 ${i}`,
        templateId,
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      pageIds.push((created.value as { pageId: string }).pageId);
    }

    const r = await callOverMcp("delete_pages_many", {
      items: pageIds.map((pageId) => ({ pageId, disposition: "404" })),
    });
    expect(r.ok).toBe(true);
    expect(r.approval?.domain).toBe("tool_approvals");
    const proposalId = r.approval?.proposalId ?? "";

    const liveCount = () =>
      withSystemTx(async (tx) => {
        const rows = (await tx.unsafe(
          "SELECT count(*)::int AS c FROM pages WHERE slug LIKE 't687-page-%' AND deleted_at IS NULL",
        )) as Array<{ c: number }>;
        return rows[0]?.c ?? -1;
      });
    expect(await liveCount()).toBe(5);

    const approved = await approveQueuedToolCall({ registry, adapter, approverCtx, proposalId });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.ok).toBe(true);
    expect(await liveCount()).toBe(0);
    expect((await outcome(proposalId)).outcome).toBe("applied");
  });
});

describe("#687 — no gated tool drops off the Power-MCP surface", () => {
  it("every gated chat-runner tool (core gated, needsApproval, plugin approvalMode) is served", () => {
    const tools = createDefaultToolRegistry();
    const served = new Map(powerToolCatalogue(tools).map((t) => [t.name, t]));
    const gatedCore = tools
      .list()
      .filter((t) => t.gated !== undefined || t.needsApproval !== undefined)
      .map((t) => t.name);
    const gatedPlugin = pluginToolsRegistry
      .list()
      .filter((p) => p.spec.approvalMode !== undefined)
      .map((p) => p.spec.name);
    expect(gatedCore.length).toBeGreaterThan(10);
    expect(gatedPlugin).toContain("set_locales");

    const missing = [...gatedCore, ...gatedPlugin].filter((name) => {
      if (served.has(name)) return false;
      // An exclusion must say why (POWER_MCP_EXCLUDED_TOOLS carries it).
      return !(POWER_MCP_EXCLUDED_TOOLS.get(name) ?? "").trim();
    });
    expect(missing).toEqual([]);

    for (const name of [...gatedCore, ...gatedPlugin]) {
      const entry = served.get(name);
      if (!entry) continue;
      // The surface explains the card instead of sending the operator to
      // paste prompts into the admin chat.
      expect(entry.description).toContain("Over MCP:");
      expect(entry.description).toContain("never ask them to paste a prompt");
    }
    for (const name of gatedPlugin) expect(served.get(name)?.gated).toBe(true);
  });
});
